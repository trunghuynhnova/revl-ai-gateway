// SPEC sections 2, 3 and 8: provider keys, gateway access keys, rate limiting.

import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ANTHROPIC_KEY_1,
  ANTHROPIC_PATH,
  FakeRateLimiter,
  GATEWAY_KEY_A,
  GATEWAY_KEY_B,
  GATEWAY_KEY_DISABLED,
  GATEWAY_KEY_UNKNOWN,
  OPENAI_PATH,
  ROUTE_CASES,
  anthropicHeaders,
  chatBody,
  createGateway,
  expectError,
  messagesBody,
  openaiHeaders,
  sha256Hex,
} from "../testkit/harness.js";

// Shaped like a JSON Web Token, made of filler. Not a credential.
const JWT_SHAPED = ["eyJ" + "hbGciOiJub25lIn0", "eyJ" + "zdWIiOiJleGFtcGxlIn0", "ZXhhbXBsZS1zaWc"].join(".");

test("Anthropic route: Authorization without x-api-key is rejected with 400 revl_oauth_not_supported", async () => {
  const gw = createGateway();
  for (const authorization of ["Bearer sk-ant-oat01-EXAMPLE-not-a-real-token", `Bearer ${ANTHROPIC_KEY_1}`, "Basic Zm9vOmJhcg=="]) {
    const response = await gw.anthropic(messagesBody("hello"), { "x-api-key": undefined, authorization });
    await expectError(response, 400, "revl_oauth_not_supported");
  }
  assert.equal(gw.upstream.calls.length, 0);
});

test("Anthropic route: an OAuth access token sent as x-api-key is rejected", async () => {
  const gw = createGateway();
  const response = await gw.anthropic(messagesBody("hello"), {
    "x-api-key": "sk-ant-oat01-EXAMPLE-not-a-real-token",
  });
  await expectError(response, 400, "revl_oauth_not_supported");
  assert.equal(gw.upstream.calls.length, 0);
});

test("Anthropic route: with x-api-key present, a stray Authorization header is dropped, not forwarded", async () => {
  const gw = createGateway();
  const response = await gw.anthropic(messagesBody("hello"), { authorization: "Bearer stray-token-example" });
  assert.equal(response.status, 200);
  assert.equal(gw.upstream.calls[0].headers["x-api-key"], ANTHROPIC_KEY_1);
  assert.equal("authorization" in gw.upstream.calls[0].headers, false);
});

test("OpenAI route: a JWT-shaped bearer token is rejected with 400 revl_oauth_not_supported", async () => {
  const gw = createGateway();
  const response = await gw.openai(chatBody("hello"), { authorization: `Bearer ${JWT_SHAPED}` });
  await expectError(response, 400, "revl_oauth_not_supported");
  assert.equal(gw.upstream.calls.length, 0);
});

test("a missing provider key gives 401 revl_missing_provider_key on both routes", async () => {
  const gw = createGateway();
  for (const route of ROUTE_CASES) {
    const response = await gw.send(route.path, { headers: route.headers(route.noKey), body: route.body("hello") });
    await expectError(response, 401, "revl_missing_provider_key");
  }
  // Not a bearer token at all, and the other provider's header, are both "missing".
  for (const authorization of ["Basic Zm9vOmJhcg==", "Bearer", "Bearer  ", "Token abc"]) {
    await expectError(await gw.openai(chatBody("hello"), { authorization }), 401, "revl_missing_provider_key");
  }
  await expectError(
    await gw.openai(chatBody("hello"), { authorization: undefined, "x-api-key": ANTHROPIC_KEY_1 }),
    401,
    "revl_missing_provider_key",
  );
  assert.equal(gw.upstream.calls.length, 0);
});

test("missing, malformed, unknown and disabled gateway keys give 401 revl_unauthorized", async () => {
  const cases = {
    missing: undefined,
    empty: "",
    malformed: "not-a-gateway-key",
    "too short": "rvl_live_short",
    "wrong prefix": `rvl_test_${"A".repeat(40)}`,
    unknown: GATEWAY_KEY_UNKNOWN,
    disabled: GATEWAY_KEY_DISABLED,
  };
  const gw = createGateway();
  for (const [name, key] of Object.entries(cases)) {
    for (const route of ROUTE_CASES) {
      const response = await gw.send(route.path, {
        headers: route.headers({ "x-revl-key": key }),
        body: route.body("hello"),
      });
      const message = await expectError(response, 401, "revl_unauthorized");
      assert.ok(!key || !message.includes(key), `${name}: the key is echoed in the error`);
    }
  }
  assert.equal(gw.upstream.calls.length, 0);
  assert.ok(gw.logs.every((entry) => entry.tenant === null && entry.status === 401));
});

test("a key record that is corrupt or has no tenant id does not authenticate", async () => {
  const gw = createGateway();
  for (const record of ["not json", "null", "{}", '{"id":""}', '{"id":42}', '{"label":"no id"}']) {
    gw.KEYS.seed(`key:${sha256Hex(GATEWAY_KEY_UNKNOWN)}`, record);
    const response = await gw.openai(chatBody("hello"), { "x-revl-key": GATEWAY_KEY_UNKNOWN });
    await expectError(response, 401, "revl_unauthorized");
  }
  assert.equal(gw.upstream.calls.length, 0);
});

test("a gateway key is looked up by its SHA-256 digest and resolves to its tenant", async () => {
  const gw = createGateway();
  assert.equal((await gw.openai(chatBody("hello"))).status, 200);
  assert.equal((await gw.openai(chatBody("hello"), { "x-revl-key": GATEWAY_KEY_B })).status, 200);
  assert.deepEqual(gw.KEYS.ops, [
    { op: "get", key: `key:${sha256Hex(GATEWAY_KEY_A)}` },
    { op: "get", key: `key:${sha256Hex(GATEWAY_KEY_B)}` },
  ]);
  assert.deepEqual(
    gw.logs.map((entry) => entry.tenant),
    ["tenant_a", "tenant_b"],
  );
});

test('REQUIRE_GATEWAY_KEY "false" makes the key optional and the tenant "public"', async () => {
  // No KEYS namespace at all: single-tenant self-hosting does not need one.
  const gw = createGateway({ env: { REQUIRE_GATEWAY_KEY: "false", KEYS: undefined } });
  for (const route of ROUTE_CASES) {
    const without = await gw.send(route.path, {
      headers: route.headers({ "x-revl-key": undefined }),
      body: route.body("hello"),
    });
    assert.equal(without.status, 200, route.name);
    // A key that would otherwise be rejected is ignored, and still not forwarded.
    const withKey = await gw.send(route.path, {
      headers: route.headers({ "x-revl-key": GATEWAY_KEY_UNKNOWN }),
      body: route.body("hello"),
    });
    assert.equal(withKey.status, 200, route.name);
  }
  assert.equal(gw.logs.length, 4);
  assert.ok(gw.logs.every((entry) => entry.tenant === "public"));
  assert.ok(gw.upstream.calls.every((call) => !("x-revl-key" in call.headers)));
});

test("REQUIRE_GATEWAY_KEY defaults to required: only the exact string \"false\" turns it off", async () => {
  for (const value of [undefined, "", "true", "False", "0", "no"]) {
    const gw = createGateway({ env: { REQUIRE_GATEWAY_KEY: value } });
    const response = await gw.openai(chatBody("hello"), { "x-revl-key": undefined });
    await expectError(response, 401, "revl_unauthorized");
  }
});

test("over the limit gives 429 revl_rate_limited with Retry-After: 60", async () => {
  const limiter = new FakeRateLimiter(2);
  const gw = createGateway({ env: { RATE_LIMITER: limiter } });
  assert.equal((await gw.openai(chatBody("one"))).status, 200);
  assert.equal((await gw.anthropic(messagesBody("two"))).status, 200);
  for (const send of [() => gw.openai(chatBody("three")), () => gw.anthropic(messagesBody("four"))]) {
    const response = await send();
    assert.equal(response.headers.get("retry-after"), "60");
    await expectError(response, 429, "revl_rate_limited");
  }
  // A limited request never reaches the provider.
  assert.equal(gw.upstream.calls.length, 2);
  assert.deepEqual(
    gw.logs.map((entry) => entry.status),
    [200, 200, 429, 429],
  );
});

test("the rate limiter is keyed by tenant id, so one tenant cannot exhaust another's limit", async () => {
  const limiter = new FakeRateLimiter(1);
  const gw = createGateway({ env: { RATE_LIMITER: limiter } });
  assert.equal((await gw.openai(chatBody("a1"))).status, 200);
  assert.equal((await gw.openai(chatBody("a2"))).status, 429);
  // Tenant B is unaffected, on either route.
  assert.equal((await gw.anthropic(messagesBody("b1"), { "x-revl-key": GATEWAY_KEY_B })).status, 200);
  assert.equal((await gw.anthropic(messagesBody("b2"), { "x-revl-key": GATEWAY_KEY_B })).status, 429);
  // The key is the tenant id: never a gateway key, a provider key or a digest of one.
  assert.deepEqual(limiter.keys, ["tenant_a", "tenant_a", "tenant_b", "tenant_b"]);
});

test("requests that fail authentication do not consume the rate limit", async () => {
  const limiter = new FakeRateLimiter(1);
  const gw = createGateway({ env: { RATE_LIMITER: limiter } });
  for (let i = 0; i < 5; i++) {
    await expectError(await gw.openai(chatBody("x"), { "x-revl-key": GATEWAY_KEY_UNKNOWN }), 401, "revl_unauthorized");
  }
  assert.deepEqual(limiter.keys, []);
  assert.equal((await gw.openai(chatBody("x"))).status, 200);
});

test("without a RATE_LIMITER binding there is no rate limiting", async () => {
  const gw = createGateway();
  assert.equal("RATE_LIMITER" in gw.env, false);
  for (let i = 0; i < 150; i++) {
    const response = await gw.send(i % 2 ? OPENAI_PATH : ANTHROPIC_PATH, {
      headers: i % 2 ? openaiHeaders() : anthropicHeaders(),
      body: i % 2 ? chatBody(`n${i}`) : messagesBody(`n${i}`),
    });
    assert.equal(response.status, 200);
  }
  assert.equal(gw.upstream.calls.length, 150);
});

test('with REQUIRE_GATEWAY_KEY "false" the limiter is keyed by the "public" tenant', async () => {
  const limiter = new FakeRateLimiter(1);
  const gw = createGateway({ env: { REQUIRE_GATEWAY_KEY: "false", RATE_LIMITER: limiter } });
  assert.equal((await gw.openai(chatBody("x"), { "x-revl-key": undefined })).status, 200);
  assert.equal((await gw.openai(chatBody("y"), { "x-revl-key": undefined })).status, 429);
  assert.deepEqual(limiter.keys, ["public", "public"]);
});
