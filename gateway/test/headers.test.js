// SPEC sections 3, 5 and 10: which request headers reach upstream, which
// response headers come back, upstream errors passed through, and the log line.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANTHROPIC_KEY_1,
  ANTHROPIC_PATH,
  GATEWAY_KEY_A,
  LOG_FIELDS,
  OPENAI_KEY_1,
  OPENAI_PATH,
  RESPONSE_HEADERS,
  ROUTE_CASES,
  UUID,
  chatBody,
  createGateway,
  encode,
  messagesBody,
  reply,
} from "../testkit/harness.js";

// Everything a client, a browser or a proxy in front of the gateway might send.
const CLIENT_HEADERS = {
  accept: "application/json",
  "user-agent": "example-sdk/1.2.3",
  "x-stainless-lang": "js",
  "x-stainless-retry-count": "0",
  "anthropic-version": "2023-06-01",
  "anthropic-beta": "example-beta-2025-01-01",
  "openai-organization": "org-example",
  "openai-project": "proj_example",
  cookie: "session=example-session-cookie",
  "x-forwarded-for": "203.0.113.9",
  "x-real-ip": "203.0.113.9",
  "cf-connecting-ip": "203.0.113.9",
  "cf-ray": "example-ray",
  referer: "https://app.example/chat",
  origin: "https://app.example",
  "accept-language": "en",
  "proxy-authorization": "Basic Zm9vOmJhcg==",
  "x-custom-header": "anything",
  "x-request-id": "client-request-id",
  "x-revl-cache": "off",
  "x-revl-cache-ttl": "120",
  "x-revl-mask": "off",
  "x-revl-retries": "0",
  "x-revl-something-new": "1",
};

test("OpenAI route: only the allow-listed request headers reach upstream", async () => {
  const gw = createGateway();
  const response = await gw.openai(chatBody("hello"), { ...CLIENT_HEADERS, "x-api-key": ANTHROPIC_KEY_1 });
  assert.equal(response.status, 200);
  assert.deepEqual(gw.upstream.calls[0].headers, {
    accept: "application/json",
    authorization: `Bearer ${OPENAI_KEY_1}`,
    "content-type": "application/json",
    "openai-organization": "org-example",
    "openai-project": "proj_example",
    "user-agent": "example-sdk/1.2.3",
    "x-stainless-lang": "js",
    "x-stainless-retry-count": "0",
  });
});

test("Anthropic route: only the allow-listed request headers reach upstream", async () => {
  const gw = createGateway();
  const response = await gw.anthropic(messagesBody("hello"), {
    ...CLIENT_HEADERS,
    authorization: "Bearer stray-token-example",
  });
  assert.equal(response.status, 200);
  assert.deepEqual(gw.upstream.calls[0].headers, {
    accept: "application/json",
    "anthropic-beta": "example-beta-2025-01-01",
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
    "user-agent": "example-sdk/1.2.3",
    "x-api-key": ANTHROPIC_KEY_1,
    "x-stainless-lang": "js",
    "x-stainless-retry-count": "0",
  });
});

test("no X-Revl-* request header, and no gateway key, ever reaches upstream", async () => {
  const gw = createGateway();
  const options = {
    "x-revl-cache": "exact",
    "x-revl-cache-ttl": "600",
    "x-revl-mask": "pii,secrets",
    "x-revl-retries": "2",
    "x-revl-unknown-option": "1",
  };
  for (const route of ROUTE_CASES) {
    // Second request per route is served from the cache; the first one is retried once.
    gw.upstream.respondWith(reply(503, "busy"));
    await gw.send(route.path, { headers: route.headers(options), body: route.body("hello alice@example.com") });
    await gw.send(route.path, { headers: route.headers(options), body: route.body("hello alice@example.com") });
  }
  assert.equal(gw.upstream.calls.length, 4);
  for (const call of gw.upstream.calls) {
    assert.deepEqual(
      Object.keys(call.headers).filter((name) => name.startsWith("x-revl")),
      [],
    );
    assert.ok(!JSON.stringify(call.headers).includes(GATEWAY_KEY_A));
    assert.ok(!call.body.includes(GATEWAY_KEY_A));
    assert.ok(!call.url.includes(GATEWAY_KEY_A));
  }
});

test("every proxied response carries the five X-Revl-* headers with correct values", async () => {
  for (const route of ROUTE_CASES) {
    const gw = createGateway();
    gw.upstream.latencyMs = 37;
    const headers = route.headers({ "x-revl-cache": "exact", "x-revl-mask": "pii", "x-revl-retries": "3" });
    const body = route.body("mail alice@example.com and bob@example.org, then alice@example.com again");

    gw.upstream.respondWith(reply(500, "upstream failed"), reply(503, "upstream busy"));
    const miss = await gw.send(route.path, { headers, body });
    assert.equal(miss.status, 200);
    for (const name of RESPONSE_HEADERS) assert.ok(miss.headers.has(name), `${route.name}: ${name} missing`);
    assert.match(miss.headers.get("x-revl-request-id"), UUID);
    assert.equal(miss.headers.get("x-revl-cache-status"), "MISS");
    assert.equal(miss.headers.get("x-revl-masked"), "2");
    assert.equal(miss.headers.get("x-revl-retries"), "2");
    // Three upstream calls of 37 ms plus the two backoff sleeps.
    const expectedMs = 3 * 37 + gw.sleeps.reduce((sum, ms) => sum + ms, 0);
    assert.equal(miss.headers.get("x-revl-upstream-ms"), String(expectedMs));
    assert.match(miss.headers.get("x-revl-upstream-ms"), /^\d+$/);

    const hit = await gw.send(route.path, { headers, body });
    assert.equal(hit.headers.get("x-revl-cache-status"), "HIT");
    assert.equal(hit.headers.get("x-revl-upstream-ms"), "0");
    assert.equal(hit.headers.get("x-revl-masked"), "2");
    assert.equal(hit.headers.get("x-revl-retries"), "0");
    assert.match(hit.headers.get("x-revl-request-id"), UUID);
    assert.notEqual(hit.headers.get("x-revl-request-id"), miss.headers.get("x-revl-request-id"));

    const bypass = await gw.send(route.path, { headers: route.headers(), body: route.body("plain") });
    assert.equal(bypass.headers.get("x-revl-cache-status"), "BYPASS");
    assert.equal(bypass.headers.get("x-revl-upstream-ms"), "37");
    assert.equal(bypass.headers.get("x-revl-masked"), "0");
    assert.equal(bypass.headers.get("x-revl-retries"), "0");
  }
});

test("an upstream response cannot spoof the X-Revl-* response headers", async () => {
  const gw = createGateway();
  gw.upstream.respondWith(
    reply(200, "{}", {
      "content-type": "application/json",
      "x-revl-request-id": "spoofed",
      "x-revl-cache-status": "HIT",
      "x-revl-upstream-ms": "999999",
      "x-revl-masked": "42",
      "x-revl-retries": "3",
      "x-revl-extra": "spoofed",
    }),
  );
  const response = await gw.openai(chatBody("hello"));
  assert.match(response.headers.get("x-revl-request-id"), UUID);
  assert.equal(response.headers.get("x-revl-cache-status"), "BYPASS");
  assert.equal(response.headers.get("x-revl-upstream-ms"), "0");
  assert.equal(response.headers.get("x-revl-masked"), "0");
  assert.equal(response.headers.get("x-revl-retries"), "0");
  assert.equal(response.headers.has("x-revl-extra"), false);
});

// Deliberately odd spacing and a non-ASCII character: the bytes must come back exactly.
const UPSTREAM_ERRORS = [
  [401, '{ "error" : {"message":"Incorrect API key provided.","type":"invalid_request_error"} }\n', "application/json"],
  [429, '{"type":"error","error":{"type":"rate_limit_error","message":"Slow down \u2014 please"}}', "application/json"],
  [500, "<html><body>Internal Server Error</body></html>", "text/html; charset=utf-8"],
];

const upstreamErrorHeaders = (contentType) => [
  ["content-type", contentType],
  ["request-id", "req_upstream_error"],
  ["retry-after", "7"],
  ["x-ratelimit-remaining-requests", "0"],
  ["www-authenticate", "Bearer"],
  ["set-cookie", "session=upstream-cookie; Path=/; HttpOnly"],
  ["set-cookie", "other=upstream-cookie-2"],
  ["set-cookie2", "legacy=1"],
  ["connection", "keep-alive, x-hop-named"],
  ["keep-alive", "timeout=5"],
  ["x-hop-named", "1"],
  ["transfer-encoding", "chunked"],
  ["upgrade", "h2c"],
  ["proxy-authenticate", "Basic"],
  ["te", "trailers"],
  ["trailer", "x-checksum"],
];

test("upstream 401, 429 and 500 pass through with status, body and headers intact", async () => {
  const optionSets = [{}, { "x-revl-cache": "exact" }, { "x-revl-cache": "exact", "x-revl-mask": "pii,secrets" }];
  for (const route of ROUTE_CASES) {
    for (const [status, body, contentType] of UPSTREAM_ERRORS) {
      for (const options of optionSets) {
        const gw = createGateway();
        gw.upstream.respondWith(() => new Response(body, { status, headers: upstreamErrorHeaders(contentType) }));
        const response = await gw.send(route.path, {
          headers: route.headers(options),
          body: route.body("hello alice@example.com"),
        });
        const label = `${route.name} ${status} ${JSON.stringify(options)}`;
        assert.equal(response.status, status, label);
        assert.deepEqual(new Uint8Array(await response.arrayBuffer()), encode(body), label);
        // Exactly the upstream's end-to-end headers plus the gateway's own five.
        assert.deepEqual(
          [...response.headers].map(([name]) => name).sort(),
          ["content-type", "request-id", "retry-after", "www-authenticate", "x-ratelimit-remaining-requests", ...RESPONSE_HEADERS].sort(),
          label,
        );
        assert.equal(response.headers.get("content-type"), contentType);
        assert.equal(response.headers.get("retry-after"), "7");
        assert.equal(response.headers.get("request-id"), "req_upstream_error");
        assert.deepEqual(response.headers.getSetCookie(), []);
        assert.equal(gw.CACHE.puts.length, 0, `${label}: an error response was cached`);
      }
    }
  }
});

test("upstream error bodies that are not valid UTF-8 pass through byte for byte", async () => {
  const bytes = new Uint8Array([0xff, 0xfe, 0x00, 0x80, 0x7b, 0x22]);
  const gw = createGateway();
  for (const status of [500, 200]) {
    gw.upstream.respondWith(() => new Response(bytes, { status, headers: { "content-type": "application/octet-stream" } }));
    const response = await gw.openai(chatBody("hello"), { "x-revl-cache": "exact" });
    assert.equal(response.status, status);
    assert.deepEqual(new Uint8Array(await response.arrayBuffer()), bytes);
  }
  assert.equal(gw.CACHE.puts.length, 0);
});

test("Set-Cookie and hop-by-hop headers are dropped from successful responses too", async () => {
  const gw = createGateway();
  gw.upstream.respondWith(() => new Response('{"ok":true}', { status: 200, headers: upstreamErrorHeaders("application/json") }));
  const response = await gw.openai(chatBody("hello"));
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"ok":true}');
  for (const name of ["set-cookie", "set-cookie2", "connection", "keep-alive", "x-hop-named", "transfer-encoding", "upgrade", "proxy-authenticate", "te", "trailer"]) {
    assert.equal(response.headers.has(name), false, name);
  }
  assert.equal(response.headers.get("request-id"), "req_upstream_error");
});

test("the log entry has exactly the SPEC section 10 fields, one entry per request", async () => {
  const gw = createGateway();
  gw.upstream.latencyMs = 12;
  const first = await gw.openai(chatBody("hello alice@example.com"), { "x-revl-mask": "pii" });
  await gw.anthropic(messagesBody("hello", { stream: true }));
  await gw.send("/nope", { method: "GET" });
  await gw.send("/healthz", { method: "GET" });
  await gw.openai(chatBody("hello"), { "x-revl-key": undefined });

  assert.equal(gw.logs.length, 5);
  for (const entry of gw.logs) assert.deepEqual(Object.keys(entry), LOG_FIELDS);
  assert.equal(gw.logs[0].request_id, first.headers.get("x-revl-request-id"));
  assert.deepEqual(
    gw.logs.map(({ request_id, ...rest }) => rest),
    [
      { tenant: "tenant_a", route: OPENAI_PATH, model: "gpt-4o", status: 200, cache: "BYPASS", upstream_ms: 12, masked: 1, retries: 0, stream: false },
      { tenant: "tenant_a", route: ANTHROPIC_PATH, model: "claude-opus-5-5", status: 200, cache: "BYPASS", upstream_ms: 12, masked: 0, retries: 0, stream: true },
      { tenant: null, route: null, model: null, status: 404, cache: null, upstream_ms: 0, masked: 0, retries: 0, stream: false },
      { tenant: null, route: "/healthz", model: null, status: 200, cache: null, upstream_ms: 0, masked: 0, retries: 0, stream: false },
      { tenant: null, route: OPENAI_PATH, model: null, status: 401, cache: null, upstream_ms: 0, masked: 0, retries: 0, stream: false },
    ],
  );
  assert.equal(new Set(gw.logs.map((entry) => entry.request_id)).size, 5);
});

test("a model value that is not a plain model id is not logged", async () => {
  const gw = createGateway();
  const models = [42, null, { name: "gpt-4o" }, ["gpt-4o"], "", "has spaces", "x".repeat(129), 'quote"inside', "line\nbreak"];
  for (const model of models) await gw.openai(chatBody("hello", { model }));
  assert.ok(gw.logs.every((entry) => entry.model === null));
  await gw.openai(chatBody("hello", { model: "ft:gpt-4o-2024-08-06:example-org:custom:abc123" }));
  assert.equal(gw.logs.at(-1).model, "ft:gpt-4o-2024-08-06:example-org:custom:abc123");
});

test("the Worker entry point writes one console.log JSON line per request", async (t) => {
  const lines = [];
  t.mock.method(console, "log", (...args) => lines.push(args));
  const { default: worker } = await import("../src/index.js");
  const ctx = { waitUntil() {} };
  const health = await worker.fetch(new Request("https://gateway.test/healthz"), {}, ctx);
  const missing = await worker.fetch(new Request("https://gateway.test/nope", { method: "POST", body: "{}" }), {}, ctx);
  assert.equal(health.status, 200);
  assert.equal(missing.status, 404);
  assert.equal(lines.length, 2);
  for (const [index, response] of [health, missing].entries()) {
    assert.equal(lines[index].length, 1);
    assert.equal(typeof lines[index][0], "string");
    assert.ok(!lines[index][0].includes("\n"));
    const entry = JSON.parse(lines[index][0]);
    assert.deepEqual(Object.keys(entry), LOG_FIELDS);
    assert.match(entry.request_id, UUID);
    assert.equal(entry.request_id, response.headers.get("x-revl-request-id"));
    assert.equal(entry.status, response.status);
  }
});
