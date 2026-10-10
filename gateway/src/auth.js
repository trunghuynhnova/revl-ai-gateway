import { GatewayError, sha256Hex } from "./util.js";

export const GATEWAY_KEY_FORMAT = /^rvl_live_[A-Za-z0-9_-]{32,128}$/;
export const PUBLIC_TENANT = "public";

const unauthorized = () =>
  new GatewayError(
    401,
    "unauthorized",
    "Missing, unknown or disabled gateway key. Send a valid key in the X-Revl-Key header.",
  );

/** @param {string | null} text */
function parseKeyRecord(text) {
  try {
    return JSON.parse(text ?? "null");
  } catch {
    return null;
  }
}

/**
 * Resolves the tenant id. Only the SHA-256 digest of a gateway key is stored or looked up.
 * @param {Headers} headers
 * @param {Record<string, any>} env
 * @returns {Promise<string>}
 */
export async function authenticate(headers, env) {
  if (env.REQUIRE_GATEWAY_KEY === "false") return PUBLIC_TENANT;
  const key = headers.get("x-revl-key") ?? "";
  if (!GATEWAY_KEY_FORMAT.test(key)) throw unauthorized();
  const record = parseKeyRecord(await env.KEYS.get(`key:${await sha256Hex(key)}`));
  if (typeof record?.id !== "string" || !record.id || record.disabled) throw unauthorized();
  return record.id;
}

/**
 * @param {Record<string, any>} env
 * @param {string} tenant
 */
export async function enforceRateLimit(env, tenant) {
  if (!env.RATE_LIMITER) return;
  const { success } = await env.RATE_LIMITER.limit({ key: tenant });
  if (!success) {
    throw new GatewayError(429, "rate_limited", "Rate limit exceeded for this gateway key.", {
      "retry-after": "60",
    });
  }
}
