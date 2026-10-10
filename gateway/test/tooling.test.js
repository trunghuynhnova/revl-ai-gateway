// The parts around the Worker: the key-creation script, package.json and
// wrangler.jsonc. These pin down what the README tells an operator to do.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { createKey } from "../scripts/create-key.mjs";
import { GATEWAY_KEY_FORMAT } from "../src/auth.js";
import { LOG_FIELDS, chatBody, createGateway, sha256Hex } from "../testkit/harness.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");

/** Removes // and block comments that are outside strings, then parses. */
function parseJsonc(text) {
  const stripped = text.replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (match) => (match.startsWith('"') ? match : ""));
  return JSON.parse(stripped);
}

test("createKey returns a key in the documented format and the record the gateway expects", () => {
  const { key, digest, kvKey, record } = createKey({ id: "acme", label: "Acme production" });
  assert.match(key, /^rvl_live_[A-Za-z0-9_-]{32,}$/);
  assert.match(key, GATEWAY_KEY_FORMAT);
  assert.equal(digest, sha256Hex(key));
  assert.equal(kvKey, `key:${digest}`);
  assert.deepEqual(record, { id: "acme", label: "Acme production", disabled: false });
  assert.notEqual(createKey().key, createKey().key);
  assert.match(createKey().record.id, /^tenant_[0-9a-f]{8}$/);
});

test("createKey refuses ids and labels that are unsafe inside a shell command", () => {
  for (const id of ["", "has space", "quote'", 'quote"', "semi;colon", "$(id)", "a".repeat(65)]) {
    assert.throws(() => createKey({ id }), /--id/);
  }
  for (const label of ["quote'", "back`tick", "$(id)", "a".repeat(65)]) {
    assert.throws(() => createKey({ id: "ok", label }), /--label/);
  }
});

test("a key made by createKey authenticates once its record is in KV, and stops when disabled", async () => {
  const { key, kvKey, record } = createKey({ id: "acme" });
  const gw = createGateway();
  const send = () => gw.openai(chatBody("hello"), { "x-revl-key": key });
  assert.equal((await send()).status, 401);
  gw.KEYS.seed(kvKey, JSON.stringify(record));
  assert.equal((await send()).status, 200);
  assert.equal(gw.logs.at(-1).tenant, "acme");
  gw.KEYS.seed(kvKey, JSON.stringify({ ...record, disabled: true }));
  assert.equal((await send()).status, 401);
});

test("scripts/create-key.mjs prints the key once and the wrangler command that stores only its digest", () => {
  const script = fileURLToPath(new URL("../scripts/create-key.mjs", import.meta.url));
  const output = execFileSync(process.execPath, [script, "--id", "acme", "--label", "Acme production"], { encoding: "utf8" });
  const [key] = output.match(/rvl_live_[A-Za-z0-9_-]{32,}/) ?? [];
  assert.ok(key, "no key in the output");
  assert.equal(output.split(key).length, 2, "the key is printed more than once");
  const digest = sha256Hex(key);
  const value = '{"id":"acme","label":"Acme production","disabled":false}';
  assert.ok(output.includes(`npx wrangler kv key put "key:${digest}" '${value}' --binding KEYS --remote`), output.replace(key, "<key>"));
});

test("scripts/create-key.mjs exits with an error for an unsafe --id", () => {
  const script = fileURLToPath(new URL("../scripts/create-key.mjs", import.meta.url));
  assert.throws(() => execFileSync(process.execPath, [script, "--id", "bad id"], { encoding: "utf8", stdio: "pipe" }), /create-key: --id/);
});

test("package.json: ES modules, node --test, MIT, no runtime dependencies", () => {
  const pkg = JSON.parse(read("../package.json"));
  assert.equal(pkg.type, "module");
  assert.equal(pkg.scripts.test, "node --test");
  assert.equal(pkg.license, "MIT");
  assert.equal(pkg.version, "0.1.0");
  assert.deepEqual(pkg.dependencies ?? {}, {});
  assert.match(read("../LICENSE"), /^MIT License\n/);
});

test("wrangler.jsonc declares the bindings the gateway reads, with placeholder ids only", () => {
  const text = read("../wrangler.jsonc");
  const config = parseJsonc(text);
  assert.equal(config.name, "revl-gateway");
  assert.equal(config.main, "src/index.js");
  assert.deepEqual(
    config.kv_namespaces.map((namespace) => namespace.binding),
    ["KEYS", "CACHE"],
  );
  for (const { id } of config.kv_namespaces) assert.match(id, /^REPLACE_WITH_/);
  assert.deepEqual(config.ratelimits, [{ name: "RATE_LIMITER", namespace_id: "2001", simple: { limit: 60, period: 60 } }]);
  assert.deepEqual(config.vars, { REQUIRE_GATEWAY_KEY: "true" });
  for (const absent of ["routes", "route", "account_id", "zone_id", "workers_dev"]) assert.equal(absent in config, false, absent);
  // No 32-character hex id (an account or namespace id) anywhere in the file.
  assert.doesNotMatch(text, /\b[0-9a-f]{32}\b/);
  assert.match(text, /wrangler kv namespace create KEYS/);
  assert.match(text, /wrangler kv namespace create CACHE/);
});

test("README lists every error type the code can produce, with its status", () => {
  const sources = ["auth", "gateway", "options", "providers", "util"].map((name) => read(`../src/${name}.js`)).join("\n");
  const produced = [...sources.matchAll(/new GatewayError\(\s*(\d{3}),\s*"([a-z_]+)"/g)].map(([, status, code]) => `${status} revl_${code}`);
  const unique = [...new Set(produced)].sort();
  assert.equal(unique.length, 11);
  const readme = read("../README.md");
  for (const entry of unique) {
    const [status, type] = entry.split(" ");
    assert.ok(readme.includes(`| ${status} | \`${type}\` |`), `README does not list ${entry}`);
  }
});

test("README documents every gateway header and log field, and the SDK options from the examples", () => {
  const readme = read("../README.md");
  const headers = ["X-Revl-Key", "X-Revl-Cache", "X-Revl-Cache-TTL", "X-Revl-Mask", "X-Revl-Retries", "X-Revl-Request-Id", "X-Revl-Cache-Status", "X-Revl-Upstream-Ms", "X-Revl-Masked"];
  for (const header of headers) assert.ok(readme.includes(`\`${header}\``), header);
  for (const field of LOG_FIELDS) assert.ok(readme.includes(`\`${field}\``), field);
  const required = [
    "Status: v0.1, early, the API may change",
    "anthropic.Anthropic(",
    "openai.OpenAI(",
    "new Anthropic({",
    "new OpenAI({",
    'model="claude-opus-5-5"',
    "max_tokens=16000",
    'model: "gpt-4o"',
    "not a compliance control",
    "not affiliated with",
  ];
  for (const text of required) assert.ok(readme.includes(text), text);
});
