// SPEC section 4: X-Revl-Retries, and section 9: revl_upstream_unreachable.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ROUTE_CASES, chatBody, createGateway, expectError, messagesBody, reply } from "../testkit/harness.js";

const retries = (n) => ({ "x-revl-retries": String(n) });
const networkError = () => new TypeError("fetch failed: connection reset while talking to upstream");

test("without X-Revl-Retries nothing is retried", async () => {
  const gw = createGateway();
  gw.upstream.respondWith(reply(503, "busy"));
  const response = await gw.openai(chatBody("hello"));
  assert.equal(response.status, 503);
  assert.equal(await response.text(), "busy");
  assert.equal(response.headers.get("x-revl-retries"), "0");
  assert.equal(gw.upstream.calls.length, 1);
  assert.deepEqual(gw.sleeps, []);

  gw.upstream.respondWith(networkError());
  await expectError(await gw.openai(chatBody("hello")), 502, "revl_upstream_unreachable");
  assert.equal(gw.upstream.calls.length, 2);
  assert.deepEqual(gw.sleeps, []);
});

test("429, 500, 502, 503 and 504 are retried, and a later success is returned", async () => {
  for (const route of ROUTE_CASES) {
    for (const code of [429, 500, 502, 503, 504]) {
      const gw = createGateway();
      gw.upstream.respondWith(reply(code, "try again"));
      const response = await gw.send(route.path, { headers: route.headers(retries(2)), body: route.body("hello") });
      assert.equal(response.status, 200, `${route.name} ${code}`);
      assert.equal(response.headers.get("x-revl-retries"), "1");
      assert.equal(gw.upstream.calls.length, 2);
      assert.equal(gw.sleeps.length, 1);
      assert.equal(gw.logs[0].retries, 1);
    }
  }
});

test("a thrown network error is retried, and a later success is returned", async () => {
  const gw = createGateway();
  gw.upstream.respondWith(networkError(), networkError());
  const response = await gw.anthropic(messagesBody("hello"), retries(3));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-revl-retries"), "2");
  assert.equal(gw.upstream.calls.length, 3);
  assert.equal(gw.sleeps.length, 2);
});

test("at most n retries: the last upstream response is returned unchanged", async () => {
  for (const n of [0, 1, 2, 3]) {
    const gw = createGateway();
    // More failures queued than the gateway is allowed to consume.
    gw.upstream.respondWith(...Array.from({ length: 10 }, (_, i) => reply(503, `busy ${i}`, { "content-type": "text/plain", "retry-after": "1" })));
    const response = await gw.openai(chatBody("hello"), retries(n));
    assert.equal(gw.upstream.calls.length, n + 1, `n=${n}`);
    assert.equal(gw.sleeps.length, n, `n=${n}`);
    assert.equal(response.status, 503);
    assert.equal(await response.text(), `busy ${n}`);
    assert.equal(response.headers.get("retry-after"), "1");
    assert.equal(response.headers.get("x-revl-retries"), String(n));
  }
});

test("network errors that outlast the retries give 502 revl_upstream_unreachable", async () => {
  for (const route of ROUTE_CASES) {
    for (const n of [0, 1, 3]) {
      const gw = createGateway();
      gw.upstream.respondWith(...Array.from({ length: 10 }, networkError));
      const response = await gw.send(route.path, { headers: route.headers(retries(n)), body: route.body("hello") });
      const message = await expectError(response, 502, "revl_upstream_unreachable");
      // The runtime's own error text is not relayed.
      assert.ok(!message.includes("connection reset"));
      assert.equal(gw.upstream.calls.length, n + 1);
      assert.equal(gw.sleeps.length, n);
      assert.equal(gw.logs[0].status, 502);
      assert.equal(gw.logs[0].retries, n);
    }
  }
});

test("400, 401, 403, 404, 409 and 422 are not retried", async () => {
  for (const code of [400, 401, 403, 404, 409, 422]) {
    const gw = createGateway();
    gw.upstream.respondWith(reply(code, `{"error":"client ${code}"}`));
    const response = await gw.openai(chatBody("hello"), retries(3));
    assert.equal(response.status, code);
    assert.equal(await response.text(), `{"error":"client ${code}"}`);
    assert.equal(response.headers.get("x-revl-retries"), "0");
    assert.equal(gw.upstream.calls.length, 1, `status ${code} was retried`);
    assert.deepEqual(gw.sleeps, []);
  }
});

test("backoff uses the injected sleep, grows, and stays bounded", async () => {
  const run = async (random) => {
    const gw = createGateway({ random: () => random });
    gw.upstream.respondWith(reply(500), reply(500), reply(500));
    const started = Date.now();
    await gw.openai(chatBody("hello"), retries(3));
    // Real time did not pass: the delays went through deps.sleep.
    assert.ok(Date.now() - started < 200);
    return gw.sleeps;
  };
  assert.deepEqual(await run(0), [250, 500, 1000]);
  assert.deepEqual(await run(0.5), [375, 625, 1125]);
  const worst = await run(0.999999);
  assert.deepEqual(worst, [499, 749, 1249]);
  for (const ms of worst) assert.ok(Number.isInteger(ms) && ms > 0 && ms <= 2250);
});

test("every attempt sends the same body and headers", async () => {
  const gw = createGateway();
  const raw = '{ "model":"gpt-4o",  "messages":[{"role":"user","content":"hello"}] }';
  gw.upstream.respondWith(reply(500), networkError(), reply(429));
  const response = await gw.openai(raw, retries(3));
  assert.equal(response.status, 200);
  assert.equal(gw.upstream.calls.length, 4);
  for (const call of gw.upstream.calls) {
    assert.equal(call.body, raw);
    assert.deepEqual(call.headers, gw.upstream.calls[0].headers);
    assert.equal(call.url, gw.upstream.calls[0].url);
  }
});

test("a streamed request is retried before its first byte", async () => {
  const gw = createGateway();
  gw.upstream.respondWith(reply(503, "busy"), reply(200, "data: one\n\n", { "content-type": "text/event-stream" }));
  const response = await gw.anthropic(messagesBody("hello", { stream: true }), retries(1));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-revl-retries"), "1");
  assert.equal(await response.text(), "data: one\n\n");
});

test("a response that needed a retry is cached like any other", async () => {
  const gw = createGateway();
  const headers = { ...retries(2), "x-revl-cache": "exact" };
  gw.upstream.respondWith(reply(500, "boom"));
  const first = await gw.openai(chatBody("hello"), headers);
  const second = await gw.openai(chatBody("hello"), headers);
  assert.equal(first.headers.get("x-revl-cache-status"), "MISS");
  assert.equal(second.headers.get("x-revl-cache-status"), "HIT");
  assert.equal(gw.upstream.calls.length, 2);
  assert.equal(gw.CACHE.puts.length, 1);
  assert.equal(JSON.parse(gw.CACHE.puts[0].value).status, 200);
});
