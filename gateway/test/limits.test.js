// SPEC sections 4 and 9: body size limit, body validation, option validation.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ROUTE_CASES, chatBody, createGateway, encode, expectError, reply } from "../testkit/harness.js";

const LIMIT = 10 * 1024 * 1024;

/** A valid chat request of exactly `bytes` bytes. */
function paddedRequest(bytes) {
  const empty = JSON.stringify(chatBody(""));
  const marker = '"content":"';
  const at = empty.indexOf(marker) + marker.length;
  return encode(empty.slice(0, at) + "a".repeat(bytes - empty.length) + empty.slice(at));
}

test("a body of exactly 10 MiB is accepted", async () => {
  const gw = createGateway();
  gw.upstream.respondWith(reply(200, "{}"));
  const body = paddedRequest(LIMIT);
  assert.equal(body.byteLength, LIMIT);
  const response = await gw.openai(body);
  assert.equal(response.status, 200);
  assert.equal(gw.upstream.calls[0].bytes.byteLength, LIMIT);
});

test("a body over 10 MiB gives 413 whether Content-Length is honest, missing or lying", async () => {
  const body = paddedRequest(LIMIT + 1);
  const cases = {
    honest: { "content-length": String(LIMIT + 1) },
    missing: {},
    "lying low": { "content-length": "2" },
    "not a number": { "content-length": "banana" },
  };
  for (const route of ROUTE_CASES) {
    const gw = createGateway();
    for (const [name, headers] of Object.entries(cases)) {
      const response = await gw.send(route.path, { headers: route.headers(headers), body });
      await expectError(response, 413, "revl_payload_too_large");
      assert.equal(gw.upstream.calls.length, 0, name);
    }
  }
});

test("a declared Content-Length over the limit is refused even if the body is small", async () => {
  const gw = createGateway();
  const response = await gw.openai(chatBody("hello"), { "content-length": String(LIMIT + 1) });
  await expectError(response, 413, "revl_payload_too_large");
  assert.equal(gw.upstream.calls.length, 0);
});

test("an endless chunked body is cut off at the limit instead of being read forever", { timeout: 30_000 }, async () => {
  const chunk = new Uint8Array(64 * 1024).fill(0x20);
  let produced = 0;
  let cancelled = false;
  const endless = new ReadableStream(
    {
      pull(controller) {
        produced += chunk.byteLength;
        controller.enqueue(chunk.slice());
      },
      cancel() {
        cancelled = true;
      },
    },
    { highWaterMark: 0 },
  );
  const gw = createGateway();
  const response = await gw.openai(endless);
  await expectError(response, 413, "revl_payload_too_large");
  assert.ok(produced > LIMIT);
  assert.ok(produced <= LIMIT + 4 * chunk.byteLength, `read ${produced} bytes`);
  assert.equal(cancelled, true);
  assert.equal(gw.upstream.calls.length, 0);
});

test("a body that is not a JSON object gives 400 revl_bad_request", async () => {
  const bodies = {
    empty: "",
    whitespace: "   ",
    "invalid JSON": '{"model": "gpt-4o", ',
    "trailing comma": '{"model":"gpt-4o",}',
    "single quotes": "{'model':'gpt-4o'}",
    "two documents": "{}{}",
    array: "[]",
    "array of objects": '[{"model":"gpt-4o"}]',
    string: '"hello"',
    number: "42",
    true: "true",
    null: "null",
    "form encoded": "model=gpt-4o&prompt=hi",
    "byte order mark": "\ufeff{}",
    "invalid UTF-8": new Uint8Array([0x7b, 0x22, 0xff, 0xfe, 0x22, 0x3a, 0x31, 0x7d]),
  };
  for (const route of ROUTE_CASES) {
    const gw = createGateway();
    for (const [name, body] of Object.entries(bodies)) {
      const response = await gw.send(route.path, { headers: route.headers(), body });
      const message = await expectError(response, 400, "revl_bad_request");
      assert.match(message, /JSON object/, name);
    }
    assert.equal(gw.upstream.calls.length, 0);
  }
});

test("a POST with no body at all gives 400 revl_bad_request", async () => {
  const gw = createGateway();
  for (const route of ROUTE_CASES) {
    await expectError(await gw.send(route.path, { headers: route.headers() }), 400, "revl_bad_request");
  }
});

// [request header, name as written in the SPEC, invalid values]
const INVALID_OPTIONS = [
  ["x-revl-cache", "X-Revl-Cache", ["semantic", "on", "true", "1", "exact,off", "exact off", ""]],
  ["x-revl-cache-ttl", "X-Revl-Cache-TTL", ["abc", "-1", "+60", "1.5", "60s", "1e3", "0x10", "1 0", "60,60", ""]],
  ["x-revl-mask", "X-Revl-Mask", ["all", "on", "true", "pii,unknown", "pii;secrets", "pii secrets", "pii,off", "pii,,secrets", "email", ""]],
  ["x-revl-retries", "X-Revl-Retries", ["4", "10", "99999999999999999999", "-1", "1.0", "two", "1,1", ""]],
];

test("each invalid X-Revl-* option value gives 400 revl_bad_request naming the header", async () => {
  for (const route of ROUTE_CASES) {
    const gw = createGateway();
    for (const [header, specName, values] of INVALID_OPTIONS) {
      for (const value of values) {
        const response = await gw.send(route.path, { headers: route.headers({ [header]: value }), body: route.body("hello") });
        const message = await expectError(response, 400, "revl_bad_request");
        assert.ok(message.includes(specName), `${header}: ${JSON.stringify(value)} -> ${message}`);
        // Only the header under test is named.
        for (const [, other] of INVALID_OPTIONS) {
          if (other !== specName) assert.ok(!message.includes(`${other} `), message);
        }
      }
    }
    assert.equal(gw.upstream.calls.length, 0);
    assert.equal(gw.CACHE.ops.length, 0);
  }
});

test("an invalid option value is never echoed back in the error", async () => {
  const gw = createGateway();
  const marker = "zz-distinctive-value-zz";
  for (const [header] of INVALID_OPTIONS) {
    const message = await expectError(await gw.openai(chatBody("hello"), { [header]: marker }), 400, "revl_bad_request");
    assert.ok(!message.includes(marker), message);
  }
});

test("every documented option value is accepted, in any letter case and with spaces", async () => {
  const valid = [
    ["x-revl-cache", ["exact", "off", "EXACT", "Off", "  exact  "]],
    ["x-revl-cache-ttl", ["60", "3600", "86400", "1", "999999"]],
    ["x-revl-mask", ["pii", "secrets", "pii,secrets", "secrets, pii", "PII , Secrets", "pii,pii", "off", "OFF"]],
    ["x-revl-retries", ["0", "1", "2", "3"]],
  ];
  const gw = createGateway();
  for (const [header, values] of valid) {
    for (const value of values) {
      const response = await gw.openai(chatBody(`hello ${header} ${value}`), { [header]: value });
      assert.equal(response.status, 200, `${header}: ${JSON.stringify(value)}`);
    }
  }
});

test("options are validated before the body is read, and the provider key before both", async () => {
  // Order matters to callers only in which error they see first; pin it down.
  const gw = createGateway();
  const bad = await gw.openai("not json", { "x-revl-retries": "9" });
  assert.match(await expectError(bad, 400, "revl_bad_request"), /X-Revl-Retries/);
  const noKey = await gw.openai("not json", { "x-revl-retries": "9", authorization: undefined });
  await expectError(noKey, 401, "revl_missing_provider_key");
  const noGatewayKey = await gw.openai("not json", { "x-revl-retries": "9", authorization: undefined, "x-revl-key": undefined });
  await expectError(noGatewayKey, 401, "revl_unauthorized");
});
