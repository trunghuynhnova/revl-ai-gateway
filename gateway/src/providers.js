import { GatewayError } from "./util.js";

/** @typedef {import("./mask.js").Masker} Masker */

/**
 * @typedef {object} Route
 * @property {string} path Path served by the gateway. Also the route id in cache keys and logs.
 * @property {string} baseEnv Name of the env var that overrides the upstream base URL.
 * @property {string} defaultBase
 * @property {string} upstreamPath
 * @property {string[]} forward Provider-specific request headers that are sent upstream.
 * @property {(headers: Headers) => string} providerKey Returns the caller's provider API key or throws.
 * @property {(body: Record<string, any>, masker: Masker) => void} maskRequest
 * @property {(data: Record<string, any>, masker: Masker) => void} rehydrateResponse
 */

const missingKey = (header) =>
  new GatewayError(401, "missing_provider_key", `Send your own provider API key in the ${header} header.`);
const oauthNotSupported = () =>
  new GatewayError(
    400,
    "oauth_not_supported",
    "OAuth and subscription tokens are not accepted. Use a provider API key.",
  );

const JWT_SHAPED = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/;

const objects = (value) =>
  Array.isArray(value) ? value.filter((item) => item !== null && typeof item === "object") : [];
const isTextPart = (part) => part.type === "text" && typeof part.text === "string";

/**
 * Masks `holder[key]` when it is a string or an array of content parts.
 * @param {Record<string, any>} holder
 * @param {string} key
 * @param {Masker} masker
 * @param {boolean} [toolResults] Also mask the content of Anthropic `tool_result` parts.
 */
function maskContent(holder, key, masker, toolResults = false) {
  const content = holder[key];
  if (typeof content === "string") {
    holder[key] = masker.mask(content);
    return;
  }
  for (const part of objects(content)) {
    if (isTextPart(part)) part.text = masker.mask(part.text);
    else if (toolResults && part.type === "tool_result") maskContent(part, "content", masker);
  }
}

/** @type {Route} */
const openaiChatCompletions = {
  path: "/v1/chat/completions",
  baseEnv: "OPENAI_BASE_URL",
  defaultBase: "https://api.openai.com/v1",
  upstreamPath: "/chat/completions",
  forward: ["authorization", "openai-organization", "openai-project"],
  providerKey(headers) {
    const match = /^Bearer\s+(\S+)$/i.exec(headers.get("authorization") ?? "");
    if (!match) throw missingKey("Authorization: Bearer");
    // OpenAI API keys are opaque strings. A JWT here is a session or OAuth token.
    if (JWT_SHAPED.test(match[1])) throw oauthNotSupported();
    return match[1];
  },
  maskRequest(body, masker) {
    for (const message of objects(body.messages)) maskContent(message, "content", masker);
  },
  rehydrateResponse(data, masker) {
    for (const { message } of objects(data.choices)) {
      if (typeof message?.content === "string") message.content = masker.rehydrate(message.content);
    }
  },
};

/** @type {Route} */
const anthropicMessages = {
  path: "/v1/messages",
  baseEnv: "ANTHROPIC_BASE_URL",
  defaultBase: "https://api.anthropic.com",
  upstreamPath: "/v1/messages",
  // Authorization is deliberately absent: a bearer token never reaches Anthropic through this route.
  forward: ["x-api-key", "anthropic-version", "anthropic-beta"],
  providerKey(headers) {
    const key = headers.get("x-api-key");
    if (!key) throw headers.has("authorization") ? oauthNotSupported() : missingKey("x-api-key");
    // Anthropic OAuth access tokens carry this prefix. API keys do not.
    if (key.startsWith("sk-ant-oat")) throw oauthNotSupported();
    return key;
  },
  maskRequest(body, masker) {
    maskContent(body, "system", masker);
    for (const message of objects(body.messages)) maskContent(message, "content", masker, true);
  },
  rehydrateResponse(data, masker) {
    for (const block of objects(data.content)) {
      if (isTextPart(block)) block.text = masker.rehydrate(block.text);
    }
  },
};

/** Looked up by exact path. Nothing from the request URL is ever used to build an upstream URL. */
export const ROUTES = new Map(
  [openaiChatCompletions, anthropicMessages].map((route) => [route.path, route]),
);

/**
 * @param {Route} route
 * @param {Record<string, any>} env
 */
export function upstreamUrl(route, env) {
  const base = String(env[route.baseEnv] || route.defaultBase).replace(/\/+$/, "");
  return base + route.upstreamPath;
}
