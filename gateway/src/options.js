import { MASK_KINDS } from "./mask.js";
import { GatewayError } from "./util.js";

const TTL_DEFAULT = 3600;
const TTL_MIN = 60;
const TTL_MAX = 86400;
const RETRIES_MAX = 3;

/** The message names the header and the accepted values, never the value that was sent. */
const invalid = (header, expected) =>
  new GatewayError(400, "bad_request", `Invalid ${header} header: expected ${expected}.`);

/**
 * @param {Headers} headers
 * @param {string} name
 * @param {string} expected
 * @param {number} [max]
 * @returns {number | null} null when the header is absent.
 */
function integerHeader(headers, name, expected, max = Infinity) {
  const raw = headers.get(name);
  if (raw === null) return null;
  // Any run of digits is a whole number. One that is too large for a TTL is clamped, not rejected.
  if (!/^\d+$/.test(raw.trim()) || Number(raw) > max) throw invalid(name, expected);
  return Number(raw);
}

/**
 * Parses the X-Revl-* request options.
 * @param {Headers} headers
 * @returns {{ cache: "exact" | "off", ttl: number, mask: string[], retries: number }}
 */
export function parseOptions(headers) {
  const cache = (headers.get("x-revl-cache") ?? "off").trim().toLowerCase();
  if (cache !== "exact" && cache !== "off") throw invalid("X-Revl-Cache", '"exact" or "off"');

  const ttl = integerHeader(headers, "X-Revl-Cache-TTL", "a whole number of seconds") ?? TTL_DEFAULT;

  const kinds = (headers.get("x-revl-mask") ?? "off").split(",").map((kind) => kind.trim().toLowerCase());
  const maskOff = kinds.length === 1 && kinds[0] === "off";
  if (!maskOff && !kinds.every((kind) => MASK_KINDS.includes(kind))) {
    throw invalid("X-Revl-Mask", 'a comma-separated list of "pii" and "secrets", or "off"');
  }

  const retries =
    integerHeader(headers, "X-Revl-Retries", `a whole number from 0 to ${RETRIES_MAX}`, RETRIES_MAX) ?? 0;

  return {
    cache,
    ttl: Math.min(Math.max(ttl, TTL_MIN), TTL_MAX),
    mask: maskOff ? [] : kinds,
    retries,
  };
}
