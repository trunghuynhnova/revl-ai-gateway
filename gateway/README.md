# Revl Gateway

Revl Gateway is a small, open-source gateway that sits between your application
and the Anthropic Messages API or the OpenAI Chat Completions API. It runs as a
Cloudflare Worker, forwards each request in the provider's own wire format with
the caller's own provider API key, and can add an exact-match response cache,
masking of personal data and secrets, retries, a per-tenant rate limit and a
metadata-only log line. The contract it implements is [SPEC.md](SPEC.md).

**Status: v0.1, early, the API may change.**

## Bring your own key

Revl AI does not resell, sublicense, pool or share model-provider API access.
Every request is authenticated to Anthropic or OpenAI with the caller's own API
key, under the caller's own provider account, billing and that provider's terms
and usage policies. A provider key is forwarded for the single request it
arrives with and is never stored or logged. OAuth and consumer subscription
tokens are rejected; only provider API keys are accepted. The gateway has no
provider credentials of its own.

## What is in v0.1

| Available in v0.1 | On the roadmap, not built |
|---|---|
| BYOK passthrough for `POST /v1/chat/completions` (OpenAI) and `POST /v1/messages` (Anthropic) | Semantic (embedding-based) caching |
| Gateway access keys, stored as SHA-256 digests | Caching and rehydration for streamed responses |
| Exact-match response cache, scoped to tenant and provider key | Cross-provider fallback |
| Masking of PII and secrets, with rehydration (non-streaming) | Usage dashboard and analytics API |
| Retries on 429, 500, 502, 503, 504 and network errors | Per-key budgets and per-key rate limits |
| Per-tenant rate limit | SSO and SCIM |
| Streaming passthrough | Custom masking detectors |
| One metadata log line per request | |

Roadmap items are in no committed order. Only the two endpoints above are
proxied. Every other path (models, embeddings, token counting, batches, files
and so on) returns `404 revl_not_found`.

## Self-hosting quick start

You need Node.js 20 or later and a Cloudflare account. Run these in the `gateway`
directory of a clone of https://github.com/trunghuynhnova/revl-ai-gateway.

```sh
npm install
npx wrangler login

# 1. Create the two KV namespaces. Each command prints an id.
npx wrangler kv namespace create KEYS
npx wrangler kv namespace create CACHE

# 2. Put the two ids into wrangler.jsonc, replacing
#    REPLACE_WITH_KEYS_NAMESPACE_ID and REPLACE_WITH_CACHE_NAMESPACE_ID.

# 3. Deploy. Wrangler prints the URL of your gateway.
npx wrangler deploy

# 4. Create a gateway key. The script contacts nothing: it prints the key once
#    and the "npx wrangler kv key put ..." command that stores its digest.
node scripts/create-key.mjs --id acme --label "Acme production"

# 5. Run the command the script printed, then check the gateway.
curl https://<your-gateway>/healthz
```

`/healthz` answers `{"ok":true,"version":"0.1.0"}`.

- To revoke a key, store its record again with `"disabled": true`.
- The rate limit is the `ratelimits` block in `wrangler.jsonc` (60 requests per
  60 seconds per tenant). Remove the block to turn rate limiting off.
- For a single-tenant deployment or local development you can make the gateway
  key optional: set `REQUIRE_GATEWAY_KEY` to `"false"` in `wrangler.jsonc`, or
  run `npx wrangler dev --var REQUIRE_GATEWAY_KEY:false`. Every caller is then
  the tenant `public`, and anyone who can reach the URL can use the gateway
  with their own provider key.
- `OPENAI_BASE_URL` and `ANTHROPIC_BASE_URL` (optional vars) replace the
  default upstreams `https://api.openai.com/v1` and `https://api.anthropic.com`.

A hosted gateway at `https://api.proxyrevlvay.com` is invite-only. Self-hosting
needs no invitation.

## Usage

Point the official SDK at the gateway and keep using your own provider key.
The Anthropic SDK base URL is `<gateway>` (the SDK appends `/v1/messages`); the
OpenAI SDK base URL is `<gateway>/v1`. Runnable versions of these snippets, and a `curl` script that
shows the response headers, are in [examples/](examples).

```sh
export REVL_BASE_URL=https://<your-gateway>   # no trailing slash
export REVL_API_KEY=<your gateway key>
export ANTHROPIC_API_KEY=<your own Anthropic API key>
export OPENAI_API_KEY=<your own OpenAI API key>
```

### Anthropic SDK, Python

```python
import os
import anthropic

client = anthropic.Anthropic(
    base_url=os.environ["REVL_BASE_URL"],
    api_key=os.environ["ANTHROPIC_API_KEY"],
    default_headers={"X-Revl-Key": os.environ["REVL_API_KEY"], "X-Revl-Cache": "exact"},
)

response = client.messages.create(
    model="claude-opus-5-5",
    max_tokens=16000,
    messages=[{"role": "user", "content": "Explain what an API gateway does in two sentences."}],
)
for block in response.content:
    if block.type == "text":
        print(block.text)
```

### OpenAI SDK, Python

```python
import os
import openai

client = openai.OpenAI(
    base_url=os.environ["REVL_BASE_URL"] + "/v1",
    api_key=os.environ["OPENAI_API_KEY"],
    default_headers={"X-Revl-Key": os.environ["REVL_API_KEY"], "X-Revl-Cache": "exact"},
)

completion = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Explain what an API gateway does in two sentences."}],
)
print(completion.choices[0].message.content)
```

### Anthropic SDK, Node.js

```js
import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({
  baseURL: process.env.REVL_BASE_URL,
  apiKey: process.env.ANTHROPIC_API_KEY,
  defaultHeaders: { "X-Revl-Key": process.env.REVL_API_KEY, "X-Revl-Cache": "exact" },
});

const response = await client.messages.create({
  model: "claude-opus-5-5",
  max_tokens: 16000,
  messages: [{ role: "user", content: "Explain what an API gateway does in two sentences." }],
});
for (const block of response.content) {
  if (block.type === "text") console.log(block.text);
}
```

### OpenAI SDK, Node.js

```js
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: `${process.env.REVL_BASE_URL}/v1`,
  apiKey: process.env.OPENAI_API_KEY,
  defaultHeaders: { "X-Revl-Key": process.env.REVL_API_KEY, "X-Revl-Cache": "exact" },
});

const completion = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Explain what an API gateway does in two sentences." }],
});
console.log(completion.choices[0].message.content);
```

## Request headers

| Header | Values | Default | Effect |
|---|---|---|---|
| `X-Revl-Key` | `rvl_live_...` | required unless `REQUIRE_GATEWAY_KEY` is `"false"` | Gateway access key. Identifies the tenant |
| `X-Revl-Cache` | `exact`, `off` | `off` | Exact-match response cache for this request |
| `X-Revl-Cache-TTL` | seconds | `3600` | Lifetime of the cache entry, clamped to 60..86400 |
| `X-Revl-Mask` | comma list of `pii`, `secrets`; or `off` | `off` | Mask matches before the request leaves the gateway |
| `X-Revl-Retries` | `0`..`3` | `0` | Retry upstream on 429, 500, 502, 503, 504 and network errors |

The provider key travels in the provider's own header: `Authorization: Bearer
<OpenAI API key>` on the OpenAI route, `x-api-key: <Anthropic API key>` on the
Anthropic route.

No `X-Revl-*` header is ever sent upstream. Only these request headers are:
`content-type`, `accept`, `user-agent`, `x-stainless-*`, the provider key
header of the route, `openai-organization` and `openai-project` (OpenAI route),
`anthropic-version` and `anthropic-beta` (Anthropic route). Cookies and all
other client headers stay at the gateway. The query string is not forwarded.

Retries wait 250 ms, then 500 ms, then 1 s, each plus up to 250 ms of random
jitter, and only happen before the first upstream byte is relayed.

## Response headers

Added to every proxied response, including upstream errors and cache hits:

| Header | Value |
|---|---|
| `X-Revl-Request-Id` | UUID of this request, also the `request_id` in the log line |
| `X-Revl-Cache-Status` | `HIT`, `MISS` or `BYPASS` (cache off, or a streamed request) |
| `X-Revl-Upstream-Ms` | Milliseconds spent waiting for the provider, retries included. An integer, `0` on a hit |
| `X-Revl-Masked` | Number of distinct values masked in the request |
| `X-Revl-Retries` | Retries actually used |

The upstream status code and body are returned unchanged, including provider
errors, so each SDK's own error handling keeps working. `Set-Cookie` and
hop-by-hop headers are dropped from the upstream response.

## Errors

Errors produced by the gateway itself look like
`{"error": {"type": "revl_<code>", "message": "..."}}` and carry
`X-Revl-Request-Id`. Messages are fixed text and never quote request data.

| Status | Type | When |
|---|---|---|
| 400 | `revl_bad_request` | Body is not a JSON object, or an `X-Revl-*` option value is invalid (the message names the header) |
| 400 | `revl_oauth_not_supported` | Anthropic route: `Authorization` without `x-api-key`, or an OAuth access token as `x-api-key`. OpenAI route: a bearer token shaped like a JSON Web Token |
| 400 | `revl_mask_stream_unsupported` | `X-Revl-Mask` together with `"stream": true` |
| 401 | `revl_unauthorized` | Missing, unknown or disabled gateway key |
| 401 | `revl_missing_provider_key` | No provider key in the route's header |
| 404 | `revl_not_found` | Any path other than the two routes and `/healthz` |
| 405 | `revl_method_not_allowed` | Wrong method on a known path (see the `Allow` header) |
| 413 | `revl_payload_too_large` | Request body over 10 MiB |
| 429 | `revl_rate_limited` | Tenant over its rate limit (`Retry-After: 60`) |
| 500 | `revl_internal_error` | Unexpected failure inside the gateway. No detail is relayed |
| 502 | `revl_upstream_unreachable` | The provider could not be reached after all retries |

## Data handling and logging

- **Provider keys** are read from the request, sent to the provider with that
  request, and dropped. They are not written to KV and not logged. When the
  cache is on, a SHA-256 digest of the key is one of the inputs hashed into the
  cache key, so an entry is only served back to the same provider key.
- **Gateway keys** are stored only as SHA-256 digests, in the `KEYS` namespace
  under `key:<hex>`, next to `{"id", "label", "disabled"}`.
- **Request bodies** are never stored or logged. With the cache on, a SHA-256
  hash over tenant id, route, provider key digest, `anthropic-version`,
  `anthropic-beta` and the canonical JSON of the body is the KV key.
- **Response bodies** are stored only when the request asked for
  `X-Revl-Cache: exact`, was not streamed, the provider answered 200, the body
  is at most 1 MiB and it does not contain the caller's provider key or gateway
  key. The entry holds status, content type and body, lives in the `CACHE`
  namespace for the TTL, and is readable only by the same tenant with the same
  provider key. It is stored as the provider returned it: with masking on it
  contains placeholders, with masking off it contains whatever the model wrote.
- **Logs**: one `console.log` JSON line per request with exactly `request_id`,
  `tenant`, `route`, `model`, `status`, `cache`, `upstream_ms`, `masked`,
  `retries`, `stream`. No bodies, no headers, no keys, no key digests. The
  model name is logged only when it looks like a model id and not like a key.
- The masking map of a request exists only in memory while that request runs.

## Masking and its limits

`X-Revl-Mask: pii` replaces email addresses, phone numbers, payment card
numbers that pass the Luhn check and IPv4 addresses. `X-Revl-Mask: secrets`
replaces `sk-...` style API keys, AWS access key ids, GitHub tokens, Slack
tokens, JSON Web Tokens and PEM private key blocks. Values become placeholders
such as `<EMAIL_1>` before the request leaves the gateway, and placeholders in
the reply are turned back into the original values.

Masking is pattern based. **It will miss things and is not a compliance control
by itself.** Specifically:

- It knows only the patterns above. Names, postal addresses, dates of birth,
  national id numbers, bank account numbers, IPv6 addresses and free-form
  secrets are not detected.
- A phone number is 8 to 15 digits with a leading `+`, a bracketed area code or
  at least three digit groups. A bare run of digits is left alone, so that an
  order number is not mistaken for one. Other grouped numbers can be masked by
  mistake.
- A card number is 13 to 19 digits that pass the Luhn check, unbroken or in the
  usual printed groups.
- It is applied to message text only: OpenAI `messages[].content`; Anthropic
  `system`, `messages[].content` and the text of `tool_result` blocks. Tool
  definitions, tool call arguments, images, documents and other fields are
  forwarded as they are.
- Placeholders are restored only in OpenAI `choices[].message.content` and
  Anthropic `content[]` text blocks, not in tool call arguments. A placeholder
  the model rewrites or splits is not restored.
- It does not work with streaming (`400 revl_mask_stream_unsupported`).
- When something was masked, the request body is serialised again as JSON, so
  whitespace and number formatting can differ from what the client sent.

## Development

```sh
npm test
```

The tests use only `node:test` and `node:assert`, with in-memory fakes for KV,
the rate limiter and the provider. They make no network calls and need no
Cloudflare account.

## Security

See [SECURITY.md](SECURITY.md) for how to report a vulnerability.

## Licence

MIT. See [LICENSE](LICENSE).

Revl AI is an independent project. It is not affiliated with, endorsed by or
sponsored by Anthropic or OpenAI. Their names are used only to say which APIs
the gateway forwards to.
