// SPEC section 2: routes, unknown paths, wrong methods, and the guarantee that
// nothing in a request can choose the upstream URL.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  ANTHROPIC_UPSTREAM,
  OPENAI_PATH,
  OPENAI_UPSTREAM,
  ROUTE_CASES,
  UUID,
  chatBody,
  createGateway,
  expectError,
} from "../testkit/harness.js";

const UPSTREAMS = [OPENAI_UPSTREAM, ANTHROPIC_UPSTREAM];

test("GET /healthz returns the documented body and touches neither KV nor upstream", async () => {
  const gw = createGateway();
  const response = await gw.send("/healthz", { method: "GET" });
  assert.equal(response.status, 200);
  assert.equal(await response.text(), '{"ok":true,"version":"0.1.0"}');
  assert.match(response.headers.get("x-revl-request-id"), UUID);
  assert.equal(gw.upstream.calls.length, 0);
  assert.equal(gw.KEYS.ops.length + gw.CACHE.ops.length, 0);
});

test("the version reported by /healthz is the package.json version", async () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  const response = await createGateway().send("/healthz", { method: "GET" });
  assert.equal((await response.json()).version, pkg.version);
});

test("each route posts to its fixed default upstream and does not follow redirects", async () => {
  for (const route of ROUTE_CASES) {
    const gw = createGateway();
    const response = await gw.send(route.path, { headers: route.headers(), body: route.body("hello") });
    assert.equal(response.status, 200, route.name);
    assert.equal(gw.upstream.calls.length, 1);
    const [call] = gw.upstream.calls;
    assert.equal(call.url, route.upstream);
    assert.equal(call.method, "POST");
    assert.equal(call.redirect, "manual");
  }
});

test("upstream base URLs come from env.OPENAI_BASE_URL and env.ANTHROPIC_BASE_URL when set", async () => {
  const gw = createGateway({
    env: {
      OPENAI_BASE_URL: "https://openai.regional.example/v1/",
      ANTHROPIC_BASE_URL: "https://anthropic.regional.example",
    },
  });
  for (const route of ROUTE_CASES) {
    await gw.send(route.path, { headers: route.headers(), body: route.body("hello") });
  }
  assert.deepEqual(
    gw.upstream.calls.map((call) => call.url),
    ["https://openai.regional.example/v1/chat/completions", "https://anthropic.regional.example/v1/messages"],
  );
});

test("unknown paths give 404 revl_not_found before any key lookup or upstream call", async () => {
  const paths = [
    "/",
    "/v1",
    "/v1/",
    "/v1/chat",
    "/v1/chat/completions/",
    "/v1/completions",
    "/v1/embeddings",
    "/v1/models",
    "/v1/responses",
    "/anthropic/v1/messages",
    "/anthropic",
    "/v1/messages/",
    "/v1/messages/batches",
    "/v1/messages/count_tokens",
    "/anthropic/v1/complete",
    "/V1/CHAT/COMPLETIONS",
    "/healthz/",
    "/healthz/x",
    "/favicon.ico",
  ];
  const gw = createGateway();
  for (const path of paths) {
    for (const route of ROUTE_CASES) {
      const post = await gw.send(path, { headers: route.headers(), body: route.body("hello") });
      await expectError(post, 404, "revl_not_found");
    }
    await expectError(await gw.send(path, { method: "GET" }), 404, "revl_not_found");
  }
  assert.equal(gw.upstream.calls.length, 0);
  assert.equal(gw.KEYS.ops.length + gw.CACHE.ops.length, 0);
  // The path is caller-supplied text, so an unknown one is not logged.
  assert.ok(gw.logs.every((entry) => entry.route === null && entry.status === 404));
});

test("path tricks can never make the gateway fetch anything but the two configured upstreams", async () => {
  // `notFound: true` means the trick must not even resolve to a route.
  const tricks = [
    { path: "//v1/chat/completions", notFound: true },
    { path: "/v1//chat/completions", notFound: true },
    { path: "//v1/messages", notFound: true },
    { path: "/v1//messages", notFound: true },
    { path: "/v1/chat/completions/../x", notFound: true },
    { path: "/v1/chat/completions/..", notFound: true },
    { path: "/v1/chat/completions/%2e%2e/x", notFound: true },
    { path: "/v1/chat/completions/..%2f..%2fx", notFound: true },
    { path: "/v1%2Fchat%2Fcompletions", notFound: true },
    { path: "/v1/chat%2Fcompletions", notFound: true },
    { path: "/v1%2fchat%2fcompletions", notFound: true },
    { path: "/v1%2Fmessages", notFound: true },
    { path: "/v1%2fmessages", notFound: true },
    { path: "/https://evil.example/v1/chat/completions", notFound: true },
    { path: "/https:%2F%2Fevil.example%2Fv1%2Fchat%2Fcompletions", notFound: true },
    { path: "/http://evil.example/v1/messages", notFound: true },
    { path: "//evil.example/v1/chat/completions", notFound: true },
    { path: "/\\evil.example/v1/chat/completions", notFound: true },
    { path: "/@evil.example/v1/chat/completions", notFound: true },
    { path: "/v1/chat/completions@evil.example", notFound: true },
    { path: "/v1/chat/completions;evil.example", notFound: true },
    { path: "/v1/chat/completions%00", notFound: true },
    { path: "/v1/chat/completions%3Fx=1", notFound: true },
    { path: "/v1/chat/completions%23", notFound: true },
    { path: "/v1/messages/../../../v1/models", notFound: true },
    // These normalise to, or simply are, a real route. They may be proxied,
    // but only ever to that route's own upstream.
    { path: "/v1/messages/../../../v1/chat/completions" },
    { path: "/x/../v1/chat/completions" },
    { path: "/%2e%2e/v1/messages" },
    { path: "/v1/chat/completions?url=https://evil.example/&base_url=https://evil.example/v1" },
    { path: "/v1/messages?upstream=https://evil.example" },
    { path: "/v1/chat/completions#@evil.example" },
  ];
  const hostile = {
    host: "evil.example",
    "x-forwarded-host": "evil.example",
    "x-forwarded-proto": "http",
    "x-original-url": "https://evil.example/v1/chat/completions",
    "x-rewrite-url": "https://evil.example/v1/chat/completions",
    forwarded: "host=evil.example;proto=http",
  };

  for (const { path, notFound } of tricks) {
    const gw = createGateway();
    for (const route of ROUTE_CASES) {
      const response = await gw.send(path, { headers: route.headers(hostile), body: route.body("hello") });
      if (notFound) await expectError(response, 404, "revl_not_found");
    }
    if (notFound) assert.equal(gw.upstream.calls.length, 0, path);
    for (const call of gw.upstream.calls) {
      assert.ok(UPSTREAMS.includes(call.url), `${path} made the gateway fetch ${call.url}`);
    }
  }
});

test("a path that normalises to a route is served by that route and its upstream only", async () => {
  const gw = createGateway();
  const response = await gw.send("/v1/messages/../../../v1/chat/completions", {
    headers: ROUTE_CASES[0].headers(),
    body: chatBody("hello"),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(
    gw.upstream.calls.map((call) => call.url),
    [OPENAI_UPSTREAM],
  );
  assert.equal(gw.logs[0].route, OPENAI_PATH);
});

test("the query string of a request is not forwarded upstream", async () => {
  const gw = createGateway();
  for (const route of ROUTE_CASES) {
    const response = await gw.send(`${route.path}?beta=true&x=https://evil.example`, {
      headers: route.headers(),
      body: route.body("hello"),
    });
    assert.equal(response.status, 200);
  }
  assert.deepEqual(
    gw.upstream.calls.map((call) => call.url),
    UPSTREAMS,
  );
});

test("wrong methods give 405 revl_method_not_allowed with an Allow header", async () => {
  const gw = createGateway();
  for (const route of ROUTE_CASES) {
    for (const method of ["GET", "HEAD", "PUT", "PATCH", "DELETE", "OPTIONS"]) {
      const bodyAllowed = method !== "GET" && method !== "HEAD";
      const response = await gw.send(route.path, {
        method,
        headers: route.headers(),
        body: bodyAllowed ? route.body("hello") : undefined,
      });
      assert.equal(response.headers.get("allow"), "POST", `${method} ${route.path}`);
      await expectError(response, 405, "revl_method_not_allowed");
    }
  }
  for (const method of ["POST", "PUT", "DELETE", "HEAD"]) {
    const response = await gw.send("/healthz", { method });
    assert.equal(response.headers.get("allow"), "GET", `${method} /healthz`);
    await expectError(response, 405, "revl_method_not_allowed");
  }
  assert.equal(gw.upstream.calls.length, 0);
  assert.equal(gw.KEYS.ops.length, 0);
});
