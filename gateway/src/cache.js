import { sha256Hex } from "./util.js";

/**
 * @typedef {object} CacheEntry
 * @property {number} status
 * @property {string} contentType
 * @property {string} body Upstream response body, before rehydration.
 */

/** JSON with object keys sorted recursively, so key order does not change the cache key. */
export function canonicalJson(/** @type {unknown} */ value) {
  return JSON.stringify(value, (_key, item) =>
    item !== null && typeof item === "object" && !Array.isArray(item)
      ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
      : item,
  );
}

/**
 * The tenant id and a digest of the provider key are part of the key, so an
 * entry is only ever served back to the same tenant using the same provider key.
 * @param {{ tenant: string, route: string, providerKey: string, version: string, beta: string, body: unknown }} parts
 */
export async function cacheKey({ tenant, route, providerKey, version, beta, body }) {
  const providerKeyHash = await sha256Hex(providerKey);
  // A JSON array keeps the fields unambiguous: no separator a value could contain.
  const material = JSON.stringify([tenant, route, providerKeyHash, version, beta, canonicalJson(body)]);
  return `cache:${await sha256Hex(material)}`;
}

/**
 * A cache that cannot be read is a miss, not an error.
 * @param {{ get(key: string): Promise<string | null> }} kv
 * @param {string} key
 * @returns {Promise<CacheEntry | null>}
 */
export async function readCache(kv, key) {
  try {
    const entry = JSON.parse((await kv.get(key)) ?? "null");
    return typeof entry?.body === "string" && Number.isInteger(entry.status) ? entry : null;
  } catch {
    return null;
  }
}

/**
 * @param {{ put(key: string, value: string, options: { expirationTtl: number }): Promise<void> }} kv
 * @param {string} key
 * @param {CacheEntry} entry
 * @param {number} ttlSeconds
 */
export function writeCache(kv, key, entry, ttlSeconds) {
  return kv.put(key, JSON.stringify(entry), { expirationTtl: ttlSeconds });
}
