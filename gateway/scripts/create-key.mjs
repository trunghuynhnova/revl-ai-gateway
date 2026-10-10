#!/usr/bin/env node
// Creates a gateway access key. Nothing is sent anywhere: the script prints the
// key once, plus the wrangler command that stores its SHA-256 digest in KV.
//
//   node scripts/create-key.mjs --id acme --label "Acme production"

import { createHash, randomBytes } from "node:crypto";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

/**
 * @param {{ id?: string, label?: string }} [options]
 * @returns {{ key: string, digest: string, kvKey: string, record: { id: string, label: string, disabled: false } }}
 */
export function createKey({ id = `tenant_${randomBytes(4).toString("hex")}`, label = "" } = {}) {
  // Both values end up inside a shell command, so keep them to a safe alphabet.
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new Error("--id must be 1 to 64 characters: letters, digits, _ or -");
  }
  if (!/^[A-Za-z0-9 _.-]{0,64}$/.test(label)) {
    throw new Error("--label must be at most 64 characters: letters, digits, space, _ . or -");
  }
  const key = `rvl_live_${randomBytes(32).toString("base64url")}`;
  const digest = createHash("sha256").update(key).digest("hex");
  return { key, digest, kvKey: `key:${digest}`, record: { id, label, disabled: false } };
}

function main() {
  const { values } = parseArgs({ options: { id: { type: "string" }, label: { type: "string" } } });
  const { key, digest, kvKey, record } = createKey(values);
  const value = JSON.stringify(record);
  console.log(`Gateway key (shown once, store it now):

  ${key}

SHA-256 of the key (the gateway stores only this):

  ${digest}

Activate the key by running this in bash or zsh:

  npx wrangler kv key put "${kvKey}" '${value}' --binding KEYS --remote

In another shell, add the entry by hand (Cloudflare dashboard, KV, your KEYS namespace):

  key    ${kvKey}
  value  ${value}

To revoke the key later, store the same value with "disabled": true.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main();
  } catch (error) {
    console.error(`create-key: ${error.message}`);
    process.exit(1);
  }
}
