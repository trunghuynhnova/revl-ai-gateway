// SPEC section 4, "Streaming": passed through unbuffered, never cached, no masking.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ROUTE_CASES, createGateway, decode, encode, expectError } from "../testkit/harness.js";

/** An upstream body the test feeds by hand, one chunk at a time. */
function manualStream() {
  let controller;
  const stream = new ReadableStream({
    start(c) {
      controller = c;
    },
  });
  return { stream, push: (text) => controller.enqueue(encode(text)), end: () => controller.close() };
}

const TIMED_OUT = Symbol("timed out");

/** Resolves with the promise's value, or with TIMED_OUT after `ms` of real time. */
async function within(ms, promise) {
  let timer;
  const timeout = new Promise((resolve) => {
    timer = setTimeout(resolve, ms, TIMED_OUT);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

test("a streamed response is relayed chunk by chunk while upstream is still open", { timeout: 10_000 }, async () => {
  for (const route of ROUTE_CASES) {
    const gw = createGateway();
    const source = manualStream();
    gw.upstream.respondWith(
      () => new Response(source.stream, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );

    // If the gateway buffered the body it could not answer yet: upstream has sent nothing so far.
    const response = await within(
      2000,
      gw.send(route.path, {
        headers: route.headers({ "x-revl-cache": "exact" }),
        body: route.body("hello", { stream: true }),
      }),
    );
    assert.notEqual(response, TIMED_OUT, "the gateway waited for the upstream body to end before answering");
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("content-type"), "text/event-stream");
    assert.equal(response.headers.get("x-revl-cache-status"), "BYPASS");

    const reader = response.body.getReader();
    source.push("data: one\n\n");
    assert.equal(decode((await reader.read()).value), "data: one\n\n");
    // The first chunk has been delivered and upstream has still not finished.
    source.push("data: two\n\n");
    assert.equal(decode((await reader.read()).value), "data: two\n\n");
    source.end();
    assert.equal((await reader.read()).done, true);

    // Nothing was looked up or written, although the caller asked for caching.
    assert.equal(gw.CACHE.ops.length, 0);
    assert.equal(gw.logs[0].stream, true);
    assert.equal(gw.logs[0].cache, "BYPASS");
  }
});

test("a streamed request is never served from, or written to, the cache", async () => {
  for (const route of ROUTE_CASES) {
    const gw = createGateway();
    const headers = route.headers({ "x-revl-cache": "exact" });
    // The same prompt without streaming fills the cache first.
    await gw.send(route.path, { headers, body: route.body("hello") });
    assert.equal(gw.CACHE.puts.length, 1);
    const opsBefore = gw.CACHE.ops.length;

    for (let i = 0; i < 2; i++) {
      const response = await gw.send(route.path, { headers, body: route.body("hello", { stream: true }) });
      assert.equal(response.headers.get("x-revl-cache-status"), "BYPASS");
      await response.text();
    }
    assert.equal(gw.CACHE.ops.length, opsBefore);
    assert.equal(gw.upstream.calls.length, 3);
  }
});

test("the request body of a streamed call reaches upstream byte for byte", async () => {
  const gw = createGateway();
  const raw = '{"stream":true,   "model":"gpt-4o","messages":[{"role":"user","content":"caf\u00e9 \\u00e9 1.0"}],"temperature":1.0}';
  await gw.openai(raw);
  assert.equal(gw.upstream.calls[0].body, raw);
});

test("masking with streaming gives 400 revl_mask_stream_unsupported", async () => {
  const gw = createGateway();
  for (const route of ROUTE_CASES) {
    for (const mask of ["pii", "secrets", "pii,secrets"]) {
      const response = await gw.send(route.path, {
        headers: route.headers({ "x-revl-mask": mask }),
        body: route.body("mail alice@example.com", { stream: true }),
      });
      await expectError(response, 400, "revl_mask_stream_unsupported");
    }
  }
  assert.equal(gw.upstream.calls.length, 0);
});

test("X-Revl-Mask: off, and stream values other than true, do not trigger that error", async () => {
  const gw = createGateway();
  const off = await gw.openai({ model: "gpt-4o", stream: true, messages: [] }, { "x-revl-mask": "off" });
  assert.equal(off.status, 200);
  for (const stream of [false, null, "true", 1]) {
    const response = await gw.openai({ model: "gpt-4o", stream, messages: [] }, { "x-revl-mask": "pii" });
    assert.equal(response.status, 200, `stream: ${JSON.stringify(stream)}`);
    assert.equal(gw.logs.at(-1).stream, false);
  }
});
