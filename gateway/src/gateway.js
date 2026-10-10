import { authenticate, enforceRateLimit } from "./auth.js";
import { cacheKey, readCache, writeCache } from "./cache.js";
import { Masker, PLACEHOLDER } from "./mask.js";
import { parseOptions } from "./options.js";
import { ROUTES, upstreamUrl } from "./providers.js";
import {
  GatewayError,
  VERSION,
  decodeUtf8,
  errorResponse,
  jsonResponse,
  parseJsonObject,
  readBody,
} from "./util.js";

/** @typedef {import("./providers.js").Route} Route */

/**
 * Everything the handler needs from the outside world, so it runs unchanged
 * in Workers and under `node --test`.
 * @typedef {object} Deps
 * @property {(url: string, init: RequestInit) => Promise<Response>} fetch
 * @property {() => number} now Current time in milliseconds.
 * @property {(ms: number) => Promise<void>} sleep
 * @property {() => number} random Uniform in [0, 1). Used for retry jitter.
 * @property {() => string} uuid
 * @property {(entry: Record<string, unknown>) => void} log
 */

const MAX_BODY_BYTES = 10 * 1024 * 1024;
const MAX_CACHED_BYTES = 1024 * 1024;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const NULL_BODY_STATUS = new Set([204, 205, 304]);

// Request headers sent upstream on every route. Each route adds its own
// (see `forward` in providers.js). Everything else stays at the gateway.
const FORWARDED_REQUEST_HEADERS = new Set(["content-type", "accept", "user-agent"]);

// Hop-by-hop headers and cookies are never relayed. The two content headers
// are dropped because the body handed back is always the decoded one, and it
// may have been rewritten by rehydration: the runtime sets them again.
const DROPPED_RESPONSE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "set-cookie",
  "set-cookie2",
  "content-encoding",
  "content-length",
]);

/**
 * @param {Request} request
 * @param {Record<string, any>} env
 * @param {{ waitUntil(promise: Promise<unknown>): void }} ctx
 * @param {Deps} deps
 * @returns {Promise<Response>}
 */
export async function handle(request, env, ctx, deps) {
  // This object is the whole log line. Nothing else about a request is logged.
  const entry = {
    request_id: deps.uuid(),
    tenant: null,
    route: null,
    model: null,
    status: 0,
    cache: null,
    upstream_ms: 0,
    masked: 0,
    retries: 0,
    stream: false,
  };
  let response;
  try {
    response = await dispatch(request, env, ctx, deps, entry);
  } catch (error) {
    response = errorResponse(error);
  }
  response.headers.set("x-revl-request-id", entry.request_id);
  entry.status = response.status;
  deps.log(entry);
  return response;
}

function dispatch(request, env, ctx, deps, entry) {
  const { pathname } = new URL(request.url);
  const route = ROUTES.get(pathname);
  if (!route && pathname !== "/healthz") throw new GatewayError(404, "not_found", "Unknown path.");
  entry.route = pathname;

  const allowed = route ? "POST" : "GET";
  if (request.method !== allowed) {
    throw new GatewayError(405, "method_not_allowed", `This path only accepts ${allowed}.`, {
      allow: allowed,
    });
  }
  return route
    ? proxy(request, env, ctx, deps, route, entry)
    : jsonResponse(200, { ok: true, version: VERSION });
}

/**
 * @param {Request} request
 * @param {Record<string, any>} env
 * @param {{ waitUntil(promise: Promise<unknown>): void }} ctx
 * @param {Deps} deps
 * @param {Route} route
 * @param {Record<string, any>} entry
 */
async function proxy(request, env, ctx, deps, route, entry) {
  entry.tenant = await authenticate(request.headers, env);
  await enforceRateLimit(env, entry.tenant);
  const providerKey = route.providerKey(request.headers);
  // Neither of the caller's keys may end up in the log line or in a cache entry.
  const callerKeys = [providerKey, request.headers.get("x-revl-key") ?? ""].filter((key) => key !== "");
  const options = parseOptions(request.headers);

  const original = await readBody(request, MAX_BODY_BYTES);
  const body = parseJsonObject(original);
  entry.model = loggableModel(body.model, callerKeys);
  entry.stream = body.stream === true;
  if (entry.stream && options.mask.length > 0) {
    throw new GatewayError(
      400,
      "mask_stream_unsupported",
      "Masking is not supported for streamed requests. Send X-Revl-Mask: off or set stream to false.",
    );
  }

  const masker = new Masker(options.mask);
  if (options.mask.length > 0) {
    // Placeholder-shaped text the caller wrote literally, anywhere in the body, is set aside first.
    masker.reserve(JSON.stringify(body));
    route.maskRequest(body, masker);
  }
  entry.masked = masker.count;
  // The caller's exact bytes go upstream unless masking changed something.
  const payload = masker.count > 0 ? JSON.stringify(body) : original;

  const cache = options.cache === "exact" && !entry.stream ? env.CACHE : undefined;
  entry.cache = cache ? "MISS" : "BYPASS";
  let key = "";
  if (cache) {
    key = await cacheKey({
      tenant: entry.tenant,
      route: route.path,
      providerKey,
      version: request.headers.get("anthropic-version") ?? "",
      beta: request.headers.get("anthropic-beta") ?? "",
      body,
    });
    const hit = await readCache(cache, key);
    if (hit) {
      entry.cache = "HIT";
      const headers = new Headers({ "content-type": hit.contentType || "application/json" });
      return proxied(hit.status, headers, rehydrate(route, masker, hit.body), entry);
    }
  }

  const started = deps.now();
  const init = {
    method: "POST",
    headers: upstreamHeaders(request.headers, route),
    body: payload,
    redirect: /** @type {const} */ ("manual"),
  };
  const upstream = await fetchWithRetries(deps, upstreamUrl(route, env), init, options.retries, entry);
  const headers = responseHeaders(upstream.headers);

  if (!cache && masker.count === 0) {
    // Nothing to store or rewrite: hand the upstream stream straight through.
    entry.upstream_ms = deps.now() - started;
    return proxied(upstream.status, headers, upstream.body, entry);
  }

  let bytes;
  try {
    bytes = new Uint8Array(await upstream.arrayBuffer());
  } catch {
    throw unreachable();
  }
  entry.upstream_ms = deps.now() - started;
  const text = upstream.status === 200 ? decodeUtf8(bytes) : null;
  if (text === null) return proxied(upstream.status, headers, bytes, entry);

  // A response that repeats one of the caller's keys is not stored: keys never reach KV.
  const storable = () => bytes.byteLength <= MAX_CACHED_BYTES && !callerKeys.some((key) => text.includes(key));
  if (cache && storable()) {
    const stored = { status: 200, contentType: headers.get("content-type") ?? "", body: text };
    ctx.waitUntil(writeCache(cache, key, stored, options.ttl).catch(() => {}));
  }
  return proxied(200, headers, masker.count > 0 ? rehydrate(route, masker, text) : bytes, entry);
}

const unreachable = () =>
  new GatewayError(502, "upstream_unreachable", "The model provider could not be reached.");

/**
 * Retries happen before any upstream byte is relayed, so they are safe for streams too.
 * @param {Deps} deps
 * @param {string} url
 * @param {RequestInit} init
 * @param {number} maxRetries
 * @param {Record<string, any>} entry
 */
async function fetchWithRetries(deps, url, init, maxRetries, entry) {
  for (let attempt = 0; ; attempt++) {
    entry.retries = attempt;
    let response = null;
    try {
      response = await deps.fetch(url, init);
    } catch {
      // Network error. Its message is dropped on purpose: it is not ours to relay.
    }
    const retryable = !response || RETRYABLE_STATUS.has(response.status);
    if (!retryable || attempt >= maxRetries) {
      if (!response) throw unreachable();
      return response;
    }
    await response?.body?.cancel().catch(() => {});
    await deps.sleep(Math.min(250 * 2 ** attempt, 2000) + Math.floor(deps.random() * 250));
  }
}

/**
 * @param {Headers} incoming
 * @param {Route} route
 */
function upstreamHeaders(incoming, route) {
  const headers = new Headers({ "content-type": "application/json" });
  for (const [name, value] of incoming) {
    const allowed =
      FORWARDED_REQUEST_HEADERS.has(name) || route.forward.includes(name) || name.startsWith("x-stainless-");
    if (allowed) headers.set(name, value);
  }
  return headers;
}

/** @param {Headers} upstream */
function responseHeaders(upstream) {
  const named = (upstream.get("connection") ?? "").toLowerCase().split(",").map((name) => name.trim());
  const headers = new Headers();
  for (const [name, value] of upstream) {
    const dropped = DROPPED_RESPONSE_HEADERS.has(name) || named.includes(name) || name.startsWith("x-revl-");
    if (!dropped) headers.append(name, value);
  }
  return headers;
}

/**
 * Restores masked values in a provider response. Anything that is not JSON, or
 * carries no placeholder, is returned untouched.
 * @param {Route} route
 * @param {Masker} masker
 * @param {string} text
 */
function rehydrate(route, masker, text) {
  if (masker.count === 0 || text.search(PLACEHOLDER) < 0) return text;
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return text;
  }
  if (data === null || typeof data !== "object") return text;
  route.rehydrateResponse(data, masker);
  return JSON.stringify(data);
}

/**
 * The model name is the only caller-supplied text in the log line, so it is
 * logged only when it looks like a model id and cannot be key material: it
 * contains neither of the caller's keys and no secret detector matches it.
 * @param {unknown} model
 * @param {string[]} keys The provider key and the gateway key sent with this request.
 */
function loggableModel(model, keys) {
  if (typeof model !== "string" || !/^[\w.:/-]{1,128}$/.test(model)) return null;
  if (keys.some((key) => model.includes(key))) return null;
  if (model.includes("rvl_live_") || new Masker(["secrets"]).mask(model) !== model) return null;
  return model;
}

/**
 * @param {number} status
 * @param {Headers} headers
 * @param {BodyInit | null} body
 * @param {Record<string, any>} entry
 */
function proxied(status, headers, body, entry) {
  headers.set("x-revl-cache-status", entry.cache);
  headers.set("x-revl-upstream-ms", String(entry.upstream_ms));
  headers.set("x-revl-masked", String(entry.masked));
  headers.set("x-revl-retries", String(entry.retries));
  return new Response(NULL_BODY_STATUS.has(status) ? null : body, { status, headers });
}
