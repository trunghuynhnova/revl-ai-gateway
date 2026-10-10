export const VERSION = "0.1.0";

/** An error reported to the caller as `{"error": {"type": "revl_<code>", "message": "..."}}`. */
export class GatewayError extends Error {
  /**
   * @param {number} status
   * @param {string} code Error type without the `revl_` prefix.
   * @param {string} message Fixed text only. Never interpolate request data: it could be key material.
   * @param {Record<string, string>} [headers]
   */
  constructor(status, code, message, headers = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.headers = headers;
  }
}

/**
 * @param {number} status
 * @param {unknown} data
 * @param {Record<string, string>} [headers]
 */
export function jsonResponse(status, data, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

/**
 * Anything that is not a GatewayError becomes a generic 500. Its message and
 * stack are dropped on purpose: runtime errors can quote header values.
 * @param {unknown} error
 */
export function errorResponse(error) {
  const known =
    error instanceof GatewayError
      ? error
      : new GatewayError(500, "internal_error", "Unexpected gateway error.");
  const body = { error: { type: `revl_${known.code}`, message: known.message } };
  return jsonResponse(known.status, body, known.headers);
}

const encoder = new TextEncoder();

/** @param {string} text */
export async function sha256Hex(text) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(text));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * @param {Uint8Array} bytes
 * @returns {string | null} null when the bytes are not valid UTF-8.
 */
export function decodeUtf8(bytes) {
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return null;
  }
}

/**
 * Reads a request body, failing as soon as it exceeds `limit` bytes.
 * Content-Length is only a shortcut: the limit is enforced on the bytes read.
 * @param {Request} request
 * @param {number} limit
 */
export async function readBody(request, limit) {
  const tooLarge = () =>
    new GatewayError(413, "payload_too_large", `Request body exceeds the ${limit} byte limit.`);
  if (Number(request.headers.get("content-length")) > limit) throw tooLarge();
  if (!request.body) return new Uint8Array(0);

  const reader = request.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      await reader.cancel().catch(() => {});
      throw tooLarge();
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * @param {Uint8Array} bytes
 * @returns {Record<string, any>}
 */
export function parseJsonObject(bytes) {
  const invalid = () => new GatewayError(400, "bad_request", "Request body must be a JSON object.");
  let value;
  try {
    value = JSON.parse(decodeUtf8(bytes) ?? "");
  } catch {
    throw invalid();
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw invalid();
  return value;
}
