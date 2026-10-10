// SPEC principle 1 and section 10: a provider key is forwarded for one request
// and appears nowhere else. This file drives the gateway through every code
// path, then searches everything it stored, logged or said for key material.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANTHROPIC_PATH,
  FakeRateLimiter,
  GATEWAY_KEY_A,
  GATEWAY_KEY_UNKNOWN,
  OPENAI_PATH,
  RESPONSE_HEADERS,
  createGateway,
  reply,
  sha256Hex,
} from "../testkit/harness.js";

// Placeholders with a distinctive marker, so that even a fragment would be noticed.
const OPENAI_MARK = "Zq9Xk7Lm";
const ANTHROPIC_MARK = "Wp4Vn8Rt";
const OPENAI_KEY = `sk-EXAMPLE-${OPENAI_MARK.repeat(4)}`;
const ANTHROPIC_KEY = `sk-ant-api03-EXAMPLE-${ANTHROPIC_MARK.repeat(4)}`;
const OAUTH_TOKEN = `sk-ant-oat01-EXAMPLE-${ANTHROPIC_MARK.repeat(4)}`;

const PROVIDER_NEEDLES = [
  OPENAI_KEY,
  ANTHROPIC_KEY,
  OPENAI_MARK,
  ANTHROPIC_MARK,
  sha256Hex(OPENAI_KEY),
  sha256Hex(ANTHROPIC_KEY),
  sha256Hex(`Bearer ${OPENAI_KEY}`),
  Buffer.from(OPENAI_KEY).toString("base64"),
  Buffer.from(ANTHROPIC_KEY).toString("base64"),
];

const ROUTES = [
  {
    path: OPENAI_PATH,
    key: OPENAI_KEY,
    headers: (extra = {}) => ({ "content-type": "application/json", authorization: `Bearer ${OPENAI_KEY}`, "x-revl-key": GATEWAY_KEY_A, ...extra }),
    body: (text, extra = {}) => ({ model: "gpt-4o", messages: [{ role: "user", content: text }], ...extra }),
  },
  {
    path: ANTHROPIC_PATH,
    key: ANTHROPIC_KEY,
    headers: (extra = {}) => ({ "content-type": "application/json", "x-api-key": ANTHROPIC_KEY, "anthropic-version": "2023-06-01", "x-revl-key": GATEWAY_KEY_A, ...extra }),
    body: (text, extra = {}) => ({ model: "claude-opus-5-5", max_tokens: 64, messages: [{ role: "user", content: text }], ...extra }),
  },
];

/** Runs every kind of request and returns what the gateway itself said in reply. */
async function exercise(gw) {
  /** @type {Array<{ what: string, status: number, text: string }>} */
  const said = [];
  const send = async (what, path, init) => {
    const response = await gw.send(path, init);
    const proxied = response.headers.has("x-revl-cache-status");
    // A proxied body belongs to the provider. Its headers, and everything about a
    // gateway-generated response, are the gateway's own words.
    const headers = JSON.stringify([...response.headers].filter(([name]) => !proxied || RESPONSE_HEADERS.includes(name)));
    said.push({ what, status: response.status, text: headers + (proxied ? "" : await response.text()) });
    return response;
  };

  for (const route of ROUTES) {
    const { path, key, headers, body } = route;
    const post = (what, extraHeaders, payload) => send(what, path, { headers: headers(extraHeaders), body: payload });

    await post("plain", {}, body("hello"));
    await post("cache miss", { "x-revl-cache": "exact" }, body("cached"));
    await post("cache hit", { "x-revl-cache": "exact" }, body("cached"));
    await post("masked and cached", { "x-revl-cache": "exact", "x-revl-mask": "pii,secrets" }, body(`my key is ${key} and my mail is alice@example.com`));
    await post("masked and cached again", { "x-revl-cache": "exact", "x-revl-mask": "pii,secrets" }, body(`my key is ${key} and my mail is alice@example.com`));
    await post("streamed", {}, body("hello", { stream: true }));

    // The key, or part of it, where a model name belongs.
    await post("key as model", { "x-revl-cache": "exact" }, body("hello", { model: key }));
    await post("key inside model", {}, body("hello", { model: `ft:${key}:x` }));
    await post("gateway key as model", { "x-revl-cache": "exact" }, body("hello", { model: GATEWAY_KEY_A }));
    await post("another secret as model", {}, body("hello", { model: `sk-ant-api03-${"Other9".repeat(6)}` }));

    // The key in every header the gateway parses.
    for (const option of ["x-revl-cache", "x-revl-cache-ttl", "x-revl-mask", "x-revl-retries"]) {
      await post(`key in ${option}`, { [option]: key }, body("hello"));
    }
    await post("key as gateway key", { "x-revl-key": key }, body("hello"));
    await post("unknown gateway key", { "x-revl-key": GATEWAY_KEY_UNKNOWN }, body("hello"));

    // Bodies the gateway rejects.
    await post("invalid JSON", {}, `{"model": "${key}", `);
    await post("non-object JSON", {}, JSON.stringify([key]));
    await post("mask with stream", { "x-revl-mask": "pii" }, body(key, { stream: true }));
    await post("too large", { "content-length": String(11 * 1024 * 1024) }, body(key));

    // Upstream failures whose own text mentions the key.
    gw.upstream.respondWith(new Error(`connect ECONNREFUSED while sending ${key}`));
    await post("network error", {}, body("hello"));
    gw.upstream.respondWith(new Error(`reset ${key}`), new Error(`reset ${key}`), new Error(`reset ${key}`));
    await post("network errors after retries", { "x-revl-retries": "2", "x-revl-cache": "exact" }, body("unreachable"));
    gw.upstream.respondWith(reply(401, `{"error":"invalid key ${key}"}`));
    await post("upstream 401", { "x-revl-cache": "exact" }, body("rejected"));
    gw.upstream.respondWith(reply(500, "boom"), reply(503, "boom"));
    await post("upstream 5xx then success", { "x-revl-retries": "3", "x-revl-cache": "exact" }, body("flaky"));

    // The key in the URL.
    await send("key in an unknown path", `${path}/${key}`, { headers: headers(), body: body("hello") });
    await send("key in the query string", `${path}?api_key=${key}`, { headers: headers(), body: body("hello") });
    await send("wrong method", path, { method: "GET", headers: headers() });
  }

  // Anthropic only: the two rejected ways of sending a token.
  const anthropic = ROUTES[1];
  await send("oauth via authorization", ANTHROPIC_PATH, {
    headers: anthropic.headers({ "x-api-key": undefined, authorization: `Bearer ${OAUTH_TOKEN}` }),
    body: anthropic.body("hello"),
  });
  await send("oauth via x-api-key", ANTHROPIC_PATH, { headers: anthropic.headers({ "x-api-key": OAUTH_TOKEN }), body: anthropic.body("hello") });

  return said;
}

test("a provider key never appears in a KV key or value, a log line, or anything the gateway says", async () => {
  const gw = createGateway();
  const said = await exercise(gw);

  // The exercise really did reach the interesting paths.
  const statuses = new Set(said.map((entry) => entry.status));
  for (const expected of [200, 400, 401, 404, 405, 413, 502]) assert.ok(statuses.has(expected), `no ${expected} was produced`);
  assert.ok(gw.CACHE.puts.length >= 6, "nothing was cached");
  assert.ok(gw.logs.some((entry) => entry.cache === "HIT"));
  assert.ok(gw.logs.some((entry) => entry.masked > 0));
  assert.ok(gw.logs.some((entry) => entry.retries > 0));
  // The keys were really in play: upstream received them, in the right header, for those requests.
  assert.ok(gw.upstream.calls.some((call) => call.headers.authorization === `Bearer ${OPENAI_KEY}`));
  assert.ok(gw.upstream.calls.some((call) => call.headers["x-api-key"] === ANTHROPIC_KEY));

  const kv = [...gw.KEYS.ops, ...gw.CACHE.ops].map((op) => JSON.stringify(op));
  const logs = gw.logs.map((entry) => JSON.stringify(entry));
  assert.ok(kv.length > 0 && logs.length === said.length);

  for (const needle of PROVIDER_NEEDLES) {
    for (const line of kv) assert.ok(!line.includes(needle), `KV operation contains key material: ${line.slice(0, 200)}`);
    for (const line of logs) assert.ok(!line.includes(needle), `log line contains key material: ${line}`);
    for (const { what, text } of said) assert.ok(!text.includes(needle), `"${what}" response contains key material: ${text.slice(0, 300)}`);
  }
});

test("the log never holds a gateway key, a key digest or a model field that looks like a secret", async () => {
  const gw = createGateway();
  await exercise(gw);
  const logs = gw.logs.map((entry) => JSON.stringify(entry)).join("\n");
  for (const needle of [GATEWAY_KEY_A, GATEWAY_KEY_UNKNOWN, "rvl_live_", sha256Hex(GATEWAY_KEY_A), sha256Hex(GATEWAY_KEY_UNKNOWN), "sk-", "Other9"]) {
    assert.ok(!logs.includes(needle), `log contains ${needle}`);
  }
  // Ordinary model names are still logged.
  assert.ok(gw.logs.some((entry) => entry.model === "gpt-4o"));
  assert.ok(gw.logs.some((entry) => entry.model === "claude-opus-5-5"));
});

test("a key that matches no secret detector is still never logged as a model or stored in the cache", async () => {
  // Opaque strings with no recognisable prefix, as a regional or compatible endpoint might issue.
  const opaque = { openai: `EXAMPLE0opaque0${OPENAI_MARK}0not0real`, anthropic: `EXAMPLE0opaque0${ANTHROPIC_MARK}0not0real` };
  const gw = createGateway({ env: { REQUIRE_GATEWAY_KEY: "false" } });
  const cached = { "x-revl-cache": "exact" };
  for (const model of [opaque.openai, `ft:${opaque.openai}:x`, "gpt-4o"]) {
    const headers = ROUTES[0].headers({ ...cached, authorization: `Bearer ${opaque.openai}`, "x-revl-key": "opaque-gateway-key-example" });
    await gw.send(OPENAI_PATH, { headers, body: ROUTES[0].body("hello", { model }) });
    await gw.send(OPENAI_PATH, { headers, body: ROUTES[0].body("hello", { model: "opaque-gateway-key-example" }) });
  }
  for (const model of [opaque.anthropic, `${opaque.anthropic}/v2`, "claude-opus-5-5"]) {
    const headers = ROUTES[1].headers({ ...cached, "x-api-key": opaque.anthropic });
    await gw.send(ANTHROPIC_PATH, { headers, body: ROUTES[1].body("hello", { model }) });
  }
  assert.deepEqual(
    gw.logs.map((entry) => entry.model),
    [null, null, null, null, "gpt-4o", null, null, null, "claude-opus-5-5"],
  );
  // The fake provider repeats the model name in its answer, so four of these answers contain a key.
  const kv = JSON.stringify(gw.CACHE.ops);
  assert.ok(!kv.includes(OPENAI_MARK) && !kv.includes(ANTHROPIC_MARK) && !kv.includes("opaque-gateway-key-example"));
  assert.equal(gw.CACHE.puts.length, 2);
  assert.ok(gw.upstream.calls.every((call) => !("x-revl-key" in call.headers)));
});

test("a gateway key is never stored or forwarded: KV sees only its digest, upstream sees nothing", async () => {
  const gw = createGateway();
  const said = await exercise(gw);
  const kv = JSON.stringify([...gw.KEYS.ops, ...gw.CACHE.ops]);
  assert.ok(!kv.includes(GATEWAY_KEY_A) && !kv.includes(GATEWAY_KEY_UNKNOWN));
  assert.ok(gw.KEYS.ops.every((op) => op.op === "get" && /^key:[0-9a-f]{64}$/.test(op.key)));
  for (const call of gw.upstream.calls) {
    const sent = call.url + JSON.stringify(call.headers);
    assert.ok(!sent.includes("rvl_live_") && !sent.includes(sha256Hex(GATEWAY_KEY_A)));
  }
  for (const { what, text } of said) assert.ok(!text.includes("rvl_live_"), `"${what}" response contains a gateway key`);
});

test("with secrets masking on, a key pasted into a prompt reaches neither the provider nor the cache", async () => {
  const gw = createGateway();
  for (const route of ROUTES) {
    const response = await gw.send(route.path, {
      headers: route.headers({ "x-revl-cache": "exact", "x-revl-mask": "secrets" }),
      body: route.body(`debug this: ${route.key}`),
    });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("x-revl-masked"), "1");
    // The caller, and only the caller, gets the text back.
    assert.ok((await response.text()).includes(route.key));
  }
  for (const call of gw.upstream.calls) assert.ok(!call.body.includes(OPENAI_MARK) && !call.body.includes(ANTHROPIC_MARK));
  const kv = JSON.stringify(gw.CACHE.ops);
  assert.ok(!kv.includes(OPENAI_MARK) && !kv.includes(ANTHROPIC_MARK));
});

test("an unexpected failure inside the gateway is a generic 500 that relays nothing", async () => {
  const gw = createGateway();
  gw.KEYS.get = async () => {
    throw new Error(`KV exploded while handling ${OPENAI_KEY}`);
  };
  const response = await gw.send(OPENAI_PATH, { headers: ROUTES[0].headers(), body: ROUTES[0].body("hello") });
  assert.equal(response.status, 500);
  assert.deepEqual(await response.json(), { error: { type: "revl_internal_error", message: "Unexpected gateway error." } });
  assert.ok(response.headers.has("x-revl-request-id"));
  assert.equal(gw.upstream.calls.length, 0);
  assert.ok(!JSON.stringify(gw.logs).includes(OPENAI_MARK));
});

test("a rate limiter failure or refusal says nothing about keys either", async () => {
  const gw = createGateway({ env: { RATE_LIMITER: new FakeRateLimiter(0) } });
  const response = await gw.send(OPENAI_PATH, { headers: ROUTES[0].headers(), body: ROUTES[0].body("hello") });
  assert.equal(response.status, 429);
  const text = await response.text();
  for (const needle of [...PROVIDER_NEEDLES, "rvl_live_"]) assert.ok(!text.includes(needle));
});
