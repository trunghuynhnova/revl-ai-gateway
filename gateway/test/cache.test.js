// SPEC section 6: the exact-match cache, its key, and what is never stored.

import assert from "node:assert/strict";
import { test } from "node:test";
import { cacheKey, canonicalJson } from "../src/cache.js";
import {
  ANTHROPIC_PATH,
  GATEWAY_KEY_B,
  OPENAI_PATH,
  ROUTE_CASES,
  anthropicHeaders,
  chatBody,
  createGateway,
  messagesBody,
  openaiHeaders,
  reply,
} from "../testkit/harness.js";

const EXACT = { "x-revl-cache": "exact" };
const status = (response) => response.headers.get("x-revl-cache-status");

test("the first request is a MISS and is stored, the second is a HIT without an upstream call", async () => {
  for (const route of ROUTE_CASES) {
    const gw = createGateway();
    const first = await gw.send(route.path, { headers: route.headers(EXACT), body: route.body("What is 2 + 2?") });
    const second = await gw.send(route.path, { headers: route.headers(EXACT), body: route.body("What is 2 + 2?") });
    assert.equal(status(first), "MISS");
    assert.equal(status(second), "HIT");
    assert.equal(gw.upstream.calls.length, 1);
    assert.equal(second.status, 200);
    assert.equal(second.headers.get("content-type"), "application/json");
    assert.equal(await second.text(), await first.text());
    assert.deepEqual(
      gw.logs.map((entry) => entry.cache),
      ["MISS", "HIT"],
    );

    // What is stored: one entry, under an opaque key, holding status, content type and body.
    assert.equal(gw.CACHE.puts.length, 1);
    const [put] = gw.CACHE.puts;
    assert.match(put.key, /^cache:[0-9a-f]{64}$/);
    assert.deepEqual(put.options, { expirationTtl: 3600 });
    const stored = JSON.parse(put.value);
    assert.deepEqual(Object.keys(stored).sort(), ["body", "contentType", "status"]);
    assert.equal(stored.status, 200);
    assert.equal(stored.contentType, "application/json");
    assert.equal(route.text(JSON.parse(stored.body)).startsWith("echo: "), true);
  }
});

test("the cache is off by default and with X-Revl-Cache: off", async () => {
  const gw = createGateway();
  for (const headers of [{}, { "x-revl-cache": "off" }]) {
    for (let i = 0; i < 2; i++) {
      assert.equal(status(await gw.openai(chatBody("same"), headers)), "BYPASS");
      assert.equal(status(await gw.anthropic(messagesBody("same"), headers)), "BYPASS");
    }
  }
  assert.equal(gw.upstream.calls.length, 8);
  assert.equal(gw.CACHE.ops.length, 0);
});

test("X-Revl-Cache: exact without a CACHE binding is a BYPASS, not an error", async () => {
  const gw = createGateway({ env: { CACHE: undefined } });
  const response = await gw.openai(chatBody("same"), EXACT);
  assert.equal(response.status, 200);
  assert.equal(status(response), "BYPASS");
});

test("an entry written by tenant A is never returned to tenant B", async () => {
  for (const route of ROUTE_CASES) {
    const gw = createGateway();
    const send = (extra) => gw.send(route.path, { headers: route.headers({ ...EXACT, ...extra }), body: route.body("shared prompt") });
    assert.equal(status(await send({})), "MISS");
    // Same provider key, same body, different gateway key.
    assert.equal(status(await send({ "x-revl-key": GATEWAY_KEY_B })), "MISS");
    assert.equal(gw.upstream.calls.length, 2);
    assert.equal(new Set(gw.CACHE.puts.map((put) => put.key)).size, 2);
    // Each tenant then hits its own entry.
    assert.equal(status(await send({})), "HIT");
    assert.equal(status(await send({ "x-revl-key": GATEWAY_KEY_B })), "HIT");
    assert.equal(gw.upstream.calls.length, 2);
  }
});

test("an entry written with provider key K1 is never returned for K2 in the same tenant", async () => {
  for (const route of ROUTE_CASES) {
    const gw = createGateway();
    const [k1, k2] = route.keys;
    const send = (key) =>
      gw.send(route.path, { headers: route.headers({ ...EXACT, ...route.keyHeader(key) }), body: route.body("shared prompt") });
    assert.equal(status(await send(k1)), "MISS");
    assert.equal(status(await send(k2)), "MISS");
    assert.equal(gw.upstream.calls.length, 2);
    assert.equal(status(await send(k1)), "HIT");
    assert.equal(status(await send(k2)), "HIT");
    assert.equal(gw.upstream.calls.length, 2);
  }
});

test("a revoked provider key cannot read an entry even when upstream would now reject it", async () => {
  // K1 fills the cache. K2 is refused by the provider and gets the provider's 401, not K1's answer.
  const gw = createGateway();
  const [k1, k2] = ROUTE_CASES[0].keys;
  await gw.openai(chatBody("shared prompt"), { ...EXACT, authorization: `Bearer ${k1}` });
  gw.upstream.respondWith(reply(401, '{"error":{"message":"bad key"}}'));
  const response = await gw.openai(chatBody("shared prompt"), { ...EXACT, authorization: `Bearer ${k2}` });
  assert.equal(response.status, 401);
  assert.equal(await response.text(), '{"error":{"message":"bad key"}}');
});

test("JSON key order and whitespace do not change the cache key", async () => {
  const gw = createGateway();
  const a = '{"model":"gpt-4o","temperature":0,"messages":[{"role":"user","content":"hi","name":"n"}],"metadata":{"a":1,"b":{"c":2,"d":3}}}';
  const b = '{\n  "metadata": {"b": {"d": 3, "c": 2}, "a": 1},\n  "messages": [{"name": "n", "content": "hi", "role": "user"}],\n  "temperature": 0,\n  "model": "gpt-4o"\n}';
  assert.equal(status(await gw.openai(a, EXACT)), "MISS");
  assert.equal(status(await gw.openai(b, EXACT)), "HIT");
  assert.equal(gw.upstream.calls.length, 1);
});

test("any difference in the body is a different cache entry", async () => {
  const gw = createGateway();
  const base = { model: "gpt-4o", temperature: 0, messages: [{ role: "system", content: "s" }, { role: "user", content: "u" }] };
  const variants = [
    base,
    { ...base, model: "gpt-4o-mini" },
    { ...base, temperature: 1 },
    { ...base, temperature: "0" },
    { ...base, messages: [base.messages[1], base.messages[0]] },
    { ...base, messages: [...base.messages, { role: "user", content: "" }] },
    { ...base, messages: [{ role: "system", content: "s" }, { role: "user", content: "U" }] },
    { ...base, max_tokens: 5 },
    { ...base, messages: JSON.stringify(base.messages) },
    { ...base, user: null },
  ];
  for (const body of variants) assert.equal(status(await gw.openai(body, EXACT)), "MISS", JSON.stringify(body));
  assert.equal(new Set(gw.CACHE.puts.map((put) => put.key)).size, variants.length);
  for (const body of variants) assert.equal(status(await gw.openai(body, EXACT)), "HIT", JSON.stringify(body));
});

test("anthropic-version and anthropic-beta are part of the key and cannot be confused with each other", async () => {
  const gw = createGateway();
  const send = (version, beta) =>
    gw.anthropic(messagesBody("same"), { ...EXACT, "anthropic-version": version, "anthropic-beta": beta });
  const combos = [
    ["2023-06-01", undefined],
    ["2023-06-01", "beta-a"],
    ["2023-06-01", "beta-a,beta-b"],
    ["2023-06-01,beta-a", "beta-b"],
    ["2023-06-01beta-a", undefined],
    ["2023-06-0", "1"],
    [undefined, "2023-06-01"],
    ['2023-06-01","beta-a', undefined],
    ["2024-01-01", "beta-a"],
  ];
  for (const [version, beta] of combos) assert.equal(status(await send(version, beta)), "MISS", `${version} / ${beta}`);
  assert.equal(new Set(gw.CACHE.puts.map((put) => put.key)).size, combos.length);
  for (const [version, beta] of combos) assert.equal(status(await send(version, beta)), "HIT", `${version} / ${beta}`);
});

test("cacheKey: fields cannot run into each other and key order does not matter", async () => {
  const base = { tenant: "t", route: "/r", providerKey: "k", version: "v", beta: "b", body: { a: 1 } };
  const variants = [
    base,
    { ...base, tenant: "t/r", route: "" },
    { ...base, tenant: "", route: "t/r" },
    { ...base, tenant: 't","/r', route: "" },
    { ...base, tenant: "t2" },
    { ...base, route: "/r2" },
    { ...base, providerKey: "k2" },
    { ...base, providerKey: "", version: "kv" },
    { ...base, version: "vb", beta: "" },
    { ...base, version: "", beta: "vb" },
    { ...base, version: 'v","b', beta: "" },
    { ...base, version: "v\nb", beta: "" },
    { ...base, version: "v|b", beta: "" },
    { ...base, version: "v:b", beta: "" },
    { ...base, beta: 'b","{\\"a\\":1}', body: "" },
    { ...base, body: '{"a":1}' },
    { ...base, body: { a: "1" } },
    { ...base, body: [{ a: 1 }] },
    { ...base, body: { a: 1, b: undefined, c: null } },
    { ...base, body: { a: { 1: 1 } } },
    { ...base, body: { "a.1": 1 } },
  ];
  const keys = await Promise.all(variants.map((parts) => cacheKey(parts)));
  for (const key of keys) assert.match(key, /^cache:[0-9a-f]{64}$/);
  assert.equal(new Set(keys).size, variants.length);

  const shuffled = { beta: "b", body: { a: 1 }, version: "v", providerKey: "k", route: "/r", tenant: "t" };
  assert.equal(await cacheKey(shuffled), keys[0]);
  assert.equal(
    await cacheKey({ ...base, body: { x: { p: 1, q: [{ m: 1, n: 2 }] }, y: 2 } }),
    await cacheKey({ ...base, body: { y: 2, x: { q: [{ n: 2, m: 1 }], p: 1 } } }),
  );
});

test("canonicalJson sorts object keys at every depth and keeps array order", () => {
  assert.equal(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: null } }), '{"a":{"c":null,"d":[3,{"y":2,"z":1}]},"b":1}');
  assert.equal(canonicalJson([2, 1]), "[2,1]");
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  assert.equal(canonicalJson("text"), '"text"');
  // An own "__proto__" key, as JSON.parse creates it, is data and must not vanish.
  const withProto = JSON.parse('{"a":1,"__proto__":{"x":1}}');
  assert.equal(canonicalJson(withProto), '{"__proto__":{"x":1},"a":1}');
  assert.notEqual(canonicalJson(withProto), canonicalJson({ a: 1 }));
});

test("upstream errors are never cached", async () => {
  for (const route of ROUTE_CASES) {
    const gw = createGateway();
    for (const code of [401, 429, 500]) {
      gw.upstream.respondWith(reply(code, `{"error":"upstream ${code}"}`));
      const response = await gw.send(route.path, { headers: route.headers(EXACT), body: route.body("same") });
      assert.equal(response.status, code);
      assert.equal(status(response), "MISS");
      assert.equal(await response.text(), `{"error":"upstream ${code}"}`);
    }
    assert.equal(gw.CACHE.puts.length, 0);
    // The provider is asked again each time, and the first success is what gets cached.
    assert.equal(gw.upstream.calls.length, 3);
    assert.equal(status(await gw.send(route.path, { headers: route.headers(EXACT), body: route.body("same") })), "MISS");
    assert.equal(status(await gw.send(route.path, { headers: route.headers(EXACT), body: route.body("same") })), "HIT");
    assert.equal(gw.upstream.calls.length, 4);
    assert.equal(gw.CACHE.puts.length, 1);
  }
});

test("non-200 success codes are not cached either", async () => {
  const gw = createGateway();
  for (const code of [201, 202, 204]) {
    gw.upstream.respondWith(reply(code, code === 204 ? null : "{}"));
    const response = await gw.openai(chatBody("same"), EXACT);
    assert.equal(response.status, code);
  }
  assert.equal(gw.CACHE.puts.length, 0);
});

test("a response body over 1 MiB is returned but not stored; exactly 1 MiB is stored", async () => {
  const MIB = 1024 * 1024;
  const bodyOf = (bytes) => `{"pad":"${"a".repeat(bytes - 10)}"}`;
  const gw = createGateway();

  gw.upstream.respondWith(reply(200, bodyOf(MIB + 1)));
  const tooBig = await gw.openai(chatBody("big"), EXACT);
  assert.equal(tooBig.status, 200);
  assert.equal((await tooBig.arrayBuffer()).byteLength, MIB + 1);
  assert.equal(gw.CACHE.puts.length, 0);

  gw.upstream.respondWith(reply(200, bodyOf(MIB)));
  const fits = await gw.openai(chatBody("fits"), EXACT);
  assert.equal((await fits.arrayBuffer()).byteLength, MIB);
  assert.equal(gw.CACHE.puts.length, 1);
});

test("X-Revl-Cache-TTL defaults to 3600 and is clamped to 60..86400", async () => {
  const cases = [
    [undefined, 3600],
    ["600", 600],
    ["60", 60],
    ["86400", 86400],
    ["0", 60],
    ["1", 60],
    ["59", 60],
    ["86401", 86400],
    ["999999999", 86400],
    ["99999999999999999999999999", 86400],
    ["0000120", 120],
  ];
  const gw = createGateway();
  for (const [index, [ttl, expected]] of cases.entries()) {
    const response = await gw.openai(chatBody(`prompt ${index}`), { ...EXACT, "x-revl-cache-ttl": ttl });
    assert.equal(response.status, 200, `TTL ${ttl}`);
    assert.deepEqual(gw.CACHE.puts.at(-1).options, { expirationTtl: expected }, `TTL ${ttl}`);
  }
  assert.equal(gw.CACHE.puts.length, cases.length);
});

test("an entry stops being served once its TTL has passed", async () => {
  const gw = createGateway();
  const send = () => gw.anthropic(messagesBody("same"), { ...EXACT, "x-revl-cache-ttl": "120" });
  assert.equal(status(await send()), "MISS");
  gw.advance(119_000);
  assert.equal(status(await send()), "HIT");
  gw.advance(1_000);
  assert.equal(status(await send()), "MISS");
  assert.equal(gw.upstream.calls.length, 2);
});

test("a cache that fails to read or write does not fail the request", async () => {
  const gw = createGateway();
  gw.CACHE.put = async () => {
    throw new Error("KV write failed");
  };
  const first = await gw.openai(chatBody("same"), EXACT);
  assert.equal(first.status, 200);
  assert.equal(status(first), "MISS");

  gw.CACHE.get = async () => {
    throw new Error("KV read failed");
  };
  const second = await gw.openai(chatBody("same"), EXACT);
  assert.equal(second.status, 200);
  assert.equal(status(second), "MISS");
  assert.equal(gw.upstream.calls.length, 2);
});

test("a corrupt cache entry is treated as a miss", async () => {
  const gw = createGateway();
  await gw.openai(chatBody("same"), EXACT);
  const { key } = gw.CACHE.puts[0];
  for (const corrupt of ["not json", "null", "[]", '{"status":200}', '{"status":"200","body":"x"}', '{"body":42,"status":200}']) {
    gw.CACHE.seed(key, corrupt);
    const response = await gw.openai(chatBody("same"), EXACT);
    assert.equal(status(response), "MISS", corrupt);
    assert.equal(response.status, 200);
  }
});

test("the two routes never share entries, even for an identical body and key", async () => {
  // Same tenant, same header value used as the provider key on both routes, same JSON body.
  const gw = createGateway();
  const body = { model: "m", max_tokens: 8, messages: [{ role: "user", content: "same" }] };
  const shared = "sk-EXAMPLE-shared-0000-not-a-real-key";
  const viaOpenai = () =>
    gw.send(OPENAI_PATH, { headers: openaiHeaders({ ...EXACT, authorization: `Bearer ${shared}` }), body });
  const viaAnthropic = () =>
    gw.send(ANTHROPIC_PATH, { headers: anthropicHeaders({ ...EXACT, "x-api-key": shared, "anthropic-version": undefined }), body });
  assert.equal(status(await viaOpenai()), "MISS");
  assert.equal(status(await viaAnthropic()), "MISS");
  assert.equal(status(await viaOpenai()), "HIT");
  assert.equal(status(await viaAnthropic()), "HIT");
  assert.equal(gw.upstream.calls.length, 2);
});
