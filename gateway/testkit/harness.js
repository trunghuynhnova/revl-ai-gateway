// Test doubles for the gateway: an in-memory KV namespace, a rate limiter and an
// upstream that records what it was sent. Nothing in here touches the network.
// The directory is deliberately not called "test": `node --test` would run it.

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { handle } from "../src/gateway.js";

export const OPENAI_PATH = "/v1/chat/completions";
export const ANTHROPIC_PATH = "/v1/messages";
export const OPENAI_UPSTREAM = "https://api.openai.com/v1/chat/completions";
export const ANTHROPIC_UPSTREAM = "https://api.anthropic.com/v1/messages";
export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** SPEC section 10, in the order it lists them. */
export const LOG_FIELDS = [
  "request_id",
  "tenant",
  "route",
  "model",
  "status",
  "cache",
  "upstream_ms",
  "masked",
  "retries",
  "stream",
];

/** SPEC section 5. */
export const RESPONSE_HEADERS = [
  "x-revl-request-id",
  "x-revl-cache-status",
  "x-revl-upstream-ms",
  "x-revl-masked",
  "x-revl-retries",
];

// Placeholders. None of these is, or was derived from, a real credential.
export const GATEWAY_KEY_A = `rvl_live_${"A".repeat(40)}`;
export const GATEWAY_KEY_B = `rvl_live_${"B".repeat(40)}`;
export const GATEWAY_KEY_DISABLED = `rvl_live_${"D".repeat(40)}`;
export const GATEWAY_KEY_UNKNOWN = `rvl_live_${"U".repeat(40)}`;
export const OPENAI_KEY_1 = "sk-EXAMPLE-openai-0001-not-a-real-key";
export const OPENAI_KEY_2 = "sk-EXAMPLE-openai-0002-not-a-real-key";
export const ANTHROPIC_KEY_1 = "sk-ant-api03-EXAMPLE-0001-not-a-real-key";
export const ANTHROPIC_KEY_2 = "sk-ant-api03-EXAMPLE-0002-not-a-real-key";

/** Computed with node:crypto, independently of the gateway's own Web Crypto code. */
export const sha256Hex = (text) => createHash("sha256").update(text).digest("hex");

export const encode = (text) => new TextEncoder().encode(text);
export const decode = (bytes) => new TextDecoder().decode(bytes);

/** In-memory stand-in for a Workers KV namespace. Records every operation. */
export class FakeKV {
  /** @param {() => number} now Clock in milliseconds, shared with the gateway. */
  constructor(now = () => 0) {
    this.now = now;
    /** @type {Map<string, { value: string, expiresAt: number | null }>} */
    this.entries = new Map();
    /** @type {Array<{ op: string, key: string, value?: string, options?: any }>} */
    this.ops = [];
  }

  /** Stores a value without recording an operation (test setup, not gateway behaviour). */
  seed(key, value) {
    this.entries.set(key, { value, expiresAt: null });
  }

  async get(key) {
    this.ops.push({ op: "get", key });
    const entry = this.entries.get(key);
    if (!entry) return null;
    if (entry.expiresAt !== null && this.now() >= entry.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    return entry.value;
  }

  async put(key, value, options = {}) {
    this.ops.push({ op: "put", key, value, options });
    // The same rules the real service enforces.
    if (typeof key !== "string" || key.length === 0 || key.length > 512) throw new Error("KV: invalid key");
    if (typeof value !== "string") throw new Error("KV: this fake stores strings only");
    const ttl = options.expirationTtl;
    if (ttl !== undefined && (!Number.isInteger(ttl) || ttl < 60)) {
      throw new Error("KV: expirationTtl must be an integer of at least 60 seconds");
    }
    this.entries.set(key, { value, expiresAt: ttl === undefined ? null : this.now() + ttl * 1000 });
  }

  async delete(key) {
    this.ops.push({ op: "delete", key });
    this.entries.delete(key);
  }

  get gets() {
    return this.ops.filter((op) => op.op === "get");
  }

  get puts() {
    return this.ops.filter((op) => op.op === "put");
  }
}

/** Stand-in for the Workers rate limiting binding: `max` calls per key, no window expiry. */
export class FakeRateLimiter {
  constructor(max = 60) {
    this.max = max;
    /** @type {string[]} Every key the gateway asked about, in order. */
    this.keys = [];
    this.counts = new Map();
  }

  async limit({ key }) {
    this.keys.push(key);
    const count = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, count);
    return { success: count <= this.max };
  }
}

/** Every string anywhere inside a JSON value. */
function strings(value) {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object") return [];
  return Object.values(value).flatMap(strings);
}

/**
 * Default upstream behaviour: a 200 in the provider's own response shape whose
 * text repeats every string of the prompt, so tests can see what upstream saw.
 */
export function echo(call) {
  const body = JSON.parse(call.body);
  const text = `echo: ${strings([body.system, body.messages]).join("\n")}`;
  const data = call.url.endsWith("/v1/messages")
    ? {
        id: "msg_test",
        type: "message",
        role: "assistant",
        model: body.model,
        content: [{ type: "text", text }],
        stop_reason: "end_turn",
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 1 },
      }
    : {
        id: "chatcmpl-test",
        object: "chat.completion",
        created: 1700000000,
        model: body.model,
        choices: [{ index: 0, message: { role: "assistant", content: text }, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      };
  return new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json", "request-id": "req_upstream_test" },
  });
}

/** A responder that builds a fresh Response each time it is used. */
export const reply =
  (status, body = "", headers = { "content-type": "application/json" }) =>
  () =>
    new Response(body, { status, headers });

/** Fake upstream `fetch`. Records each call and answers from a queue, then with `echo`. */
export class FakeUpstream {
  /** @param {(ms: number) => void} advance Moves the shared clock forward. */
  constructor(advance) {
    this.advance = advance;
    /** @type {Array<{ url: string, method: string, redirect: string, headers: Record<string, string>, body: string, bytes: Uint8Array }>} */
    this.calls = [];
    this.queue = [];
    this.fallback = echo;
    /** Simulated time each upstream call takes. */
    this.latencyMs = 0;
    this.fetch = this.fetch.bind(this);
  }

  /** Queues answers for the next calls: a responder function, or an Error to throw. */
  respondWith(...responders) {
    this.queue.push(...responders);
    return this;
  }

  async fetch(url, init = {}) {
    const bytes = typeof init.body === "string" ? encode(init.body) : new Uint8Array(init.body ?? []);
    const call = {
      url: String(url),
      method: init.method,
      redirect: init.redirect,
      headers: Object.fromEntries(new Headers(init.headers)),
      body: decode(bytes),
      bytes,
    };
    this.calls.push(call);
    this.advance(this.latencyMs);
    const next = this.queue.length > 0 ? this.queue.shift() : this.fallback;
    if (next instanceof Error) throw next;
    return next(call);
  }
}

/** Builds a Headers object. Names are case-insensitive; `undefined` removes a default. */
function buildHeaders(...sources) {
  const merged = new Map();
  for (const source of sources) {
    for (const [name, value] of Object.entries(source)) merged.set(name.toLowerCase(), value);
  }
  return new Headers([...merged].filter(([, value]) => value !== undefined));
}

export const openaiHeaders = (extra = {}) =>
  buildHeaders(
    {
      "content-type": "application/json",
      authorization: `Bearer ${OPENAI_KEY_1}`,
      "x-revl-key": GATEWAY_KEY_A,
    },
    extra,
  );

export const anthropicHeaders = (extra = {}) =>
  buildHeaders(
    {
      "content-type": "application/json",
      "x-api-key": ANTHROPIC_KEY_1,
      "anthropic-version": "2023-06-01",
      "x-revl-key": GATEWAY_KEY_A,
    },
    extra,
  );

export const chatBody = (text, extra = {}) => ({
  model: "gpt-4o",
  messages: [{ role: "user", content: text }],
  ...extra,
});

export const messagesBody = (text, extra = {}) => ({
  model: "claude-opus-5-5",
  max_tokens: 64,
  messages: [{ role: "user", content: text }],
  ...extra,
});

/** One entry per proxied route, so a test can loop over both. */
export const ROUTE_CASES = [
  {
    name: "openai",
    path: OPENAI_PATH,
    upstream: OPENAI_UPSTREAM,
    model: "gpt-4o",
    keys: [OPENAI_KEY_1, OPENAI_KEY_2],
    keyHeader: (key) => ({ authorization: `Bearer ${key}` }),
    noKey: { authorization: undefined },
    headers: openaiHeaders,
    body: chatBody,
    text: (json) => json.choices.map((choice) => choice.message.content).join(""),
  },
  {
    name: "anthropic",
    path: ANTHROPIC_PATH,
    upstream: ANTHROPIC_UPSTREAM,
    model: "claude-opus-5-5",
    keys: [ANTHROPIC_KEY_1, ANTHROPIC_KEY_2],
    keyHeader: (key) => ({ "x-api-key": key }),
    noKey: { "x-api-key": undefined },
    headers: anthropicHeaders,
    body: messagesBody,
    text: (json) =>
      json.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join(""),
  },
];

/**
 * A gateway wired to fakes. Tenants: GATEWAY_KEY_A is "tenant_a", GATEWAY_KEY_B
 * is "tenant_b", GATEWAY_KEY_DISABLED is a disabled key, GATEWAY_KEY_UNKNOWN is
 * not stored at all.
 * @param {{ env?: Record<string, any>, random?: () => number }} [options]
 */
export function createGateway({ env: envOverrides = {}, random = () => 0.5 } = {}) {
  const clock = { ms: 1_700_000_000_000 };
  const now = () => clock.ms;
  const advance = (ms) => {
    clock.ms += ms;
  };

  const KEYS = new FakeKV(now);
  const CACHE = new FakeKV(now);
  const tenant = (id, disabled = false) => JSON.stringify({ id, label: `Test ${id}`, disabled });
  KEYS.seed(`key:${sha256Hex(GATEWAY_KEY_A)}`, tenant("tenant_a"));
  KEYS.seed(`key:${sha256Hex(GATEWAY_KEY_B)}`, tenant("tenant_b"));
  KEYS.seed(`key:${sha256Hex(GATEWAY_KEY_DISABLED)}`, tenant("tenant_disabled", true));

  const upstream = new FakeUpstream(advance);
  /** @type {Array<Record<string, any>>} */
  const logs = [];
  /** @type {number[]} */
  const sleeps = [];
  const pending = [];
  let requests = 0;

  const deps = {
    fetch: upstream.fetch,
    now,
    sleep: async (ms) => {
      sleeps.push(ms);
      advance(ms);
    },
    random,
    uuid: () => `00000000-0000-4000-8000-${String(++requests).padStart(12, "0")}`,
    log: (entry) => logs.push(entry),
  };
  const ctx = {
    waitUntil(promise) {
      pending.push(promise);
    },
  };
  const env = { KEYS, CACHE, REQUIRE_GATEWAY_KEY: "true", ...envOverrides };

  /**
   * Sends one request through the gateway and waits for its background work.
   * `body` may be a string, bytes or a stream (sent as is) or a value (sent as JSON).
   */
  async function send(path, { method = "POST", headers = {}, body } = {}) {
    const init = { method, headers: headers instanceof Headers ? headers : buildHeaders(headers) };
    if (body !== undefined) {
      const raw = typeof body === "string" || body instanceof Uint8Array || body instanceof ReadableStream;
      init.body = raw ? body : JSON.stringify(body);
      if (body instanceof ReadableStream) init.duplex = "half";
    }
    // Plain concatenation on purpose: path tricks must reach the gateway untouched.
    const response = await handle(new Request(`https://gateway.test${path}`, init), env, ctx, deps);
    await Promise.allSettled(pending.splice(0));
    return response;
  }

  return {
    env,
    deps,
    ctx,
    KEYS,
    CACHE,
    upstream,
    logs,
    sleeps,
    advance,
    send,
    openai: (body, headers = {}) => send(OPENAI_PATH, { headers: openaiHeaders(headers), body }),
    anthropic: (body, headers = {}) => send(ANTHROPIC_PATH, { headers: anthropicHeaders(headers), body }),
  };
}

/**
 * Asserts the SPEC section 9 error shape and returns the message.
 * @param {Response} response
 * @param {number} status
 * @param {string} type Full error type, for example "revl_bad_request".
 */
export async function expectError(response, status, type) {
  assert.equal(response.status, status);
  assert.match(response.headers.get("content-type") ?? "", /^application\/json/);
  assert.match(response.headers.get("x-revl-request-id") ?? "", UUID);
  const body = await response.json();
  assert.deepEqual(Object.keys(body), ["error"]);
  assert.deepEqual(Object.keys(body.error), ["type", "message"]);
  assert.equal(body.error.type, type);
  assert.equal(typeof body.error.message, "string");
  assert.ok(body.error.message.length > 0);
  return body.error.message;
}
