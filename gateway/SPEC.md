# Revl Gateway: open-source core, specification v0.1

This document is the contract. The code, the tests, the README and the public
docs page must all agree with it. If something here turns out to be wrong or
impossible, change this file in the same commit and say so.

## 1. Principles

1. **BYOK (bring your own key).** The gateway holds no model-provider
   credentials. Every request carries the caller's own provider API key in that
   provider's standard header. The key is forwarded upstream for that one
   request and is never written to storage, never logged, and never used for
   any other caller.
2. **Native wire formats.** No translation layer. OpenAI-format requests go to
   OpenAI, Anthropic-format requests go to Anthropic. The body is forwarded
   unchanged unless the caller turned on masking.
3. **Tenant isolation.** Cache entries and rate limits are scoped to the
   gateway key (the tenant). A cache entry is also bound to a hash of the
   provider key, so a cached completion can never be served to a different
   provider account.
4. **Private by default.** Request and response bodies are never logged. One
   metadata line is logged per request.
5. **API keys only.** OAuth or subscription tokens are rejected. The gateway is
   for a customer's own pay-as-you-go provider API account, not for pooling or
   sharing consumer subscriptions.

## 2. Routes

| Method and path | Upstream | Provider key header (required) | Client |
|---|---|---|---|
| `POST /v1/chat/completions` | `https://api.openai.com/v1/chat/completions` | `Authorization: Bearer <OpenAI API key>` | OpenAI SDK with `base_url` = `<gateway>/v1` |
| `POST /v1/messages` | `https://api.anthropic.com/v1/messages` | `x-api-key: <Anthropic API key>` | Anthropic SDK with `base_url` = `<gateway>` (the SDK appends `/v1/messages`) |
| `GET /healthz` | none | none | returns `{"ok":true,"version":"0.1.0"}` |

- Any other path: `404 revl_not_found`. Wrong method on a known path:
  `405 revl_method_not_allowed` with an `Allow` header.
- Anthropic route: `anthropic-version` and `anthropic-beta` request headers are
  forwarded unchanged. A request on this route that carries an
  `Authorization` header and no `x-api-key` is rejected with
  `400 revl_oauth_not_supported`. So is an `x-api-key` value that starts with
  `sk-ant-oat` (an OAuth access token), and a JWT-shaped bearer token on the
  OpenAI route.
- Request headers reach the upstream by allow-list only: `content-type`,
  `accept`, `user-agent`, `x-stainless-*`, the provider key header for the
  route, plus `anthropic-version` and `anthropic-beta` (Anthropic route) or
  `openai-organization` and `openai-project` (OpenAI route). Cookies and every
  other client header are dropped. The request query string is not forwarded.
- Missing provider key on either route: `401 revl_missing_provider_key`.
- Upstream base URLs are read from `env.OPENAI_BASE_URL` and
  `env.ANTHROPIC_BASE_URL` when set (used by tests and by operators with a
  regional endpoint). Defaults are the two URLs above.

## 3. Gateway access key

- Header: `X-Revl-Key: rvl_live_<32 to 128 url-safe chars>`.
- Only the SHA-256 hex digest of a key is stored, in KV binding `KEYS` under
  `key:<hex>`, value JSON `{"id": "<tenant id>", "label": "...", "disabled": false}`.
- `env.REQUIRE_GATEWAY_KEY` defaults to `"true"`. When it is `"false"` (local
  development, single-tenant self-hosting) the header is optional and the
  tenant id is `"public"`.
- Missing, unknown or disabled key: `401 revl_unauthorized`.
- `X-Revl-Key` and every other `X-Revl-*` request header are consumed by the
  gateway and are **never forwarded upstream**.

## 4. Request options (all optional headers)

| Header | Values | Default | Effect |
|---|---|---|---|
| `X-Revl-Cache` | `exact`, `off` | `off` | Exact-match response cache for this request |
| `X-Revl-Cache-TTL` | seconds | `3600` | Clamped to 60..86400 |
| `X-Revl-Mask` | comma list of `pii`, `secrets`; or `off` | `off` | Mask matches before the request leaves the gateway |
| `X-Revl-Retries` | `0`..`3` | `0` | Retry upstream on 429, 500, 502, 503, 504 and network errors |

Invalid values: `400 revl_bad_request` naming the header.

**Streaming** (`"stream": true` in the body): the upstream response is passed
through unbuffered. Cache status is `BYPASS`. Masking with streaming is not
supported in v0.1: `400 revl_mask_stream_unsupported`. Retries apply only
before the first upstream byte.

## 5. Response headers (added to every proxied response)

`X-Revl-Request-Id` (uuid), `X-Revl-Cache-Status` (`HIT`, `MISS`, or `BYPASS`
when the cache was not used for this request: caching is off or the request is
streaming), `X-Revl-Upstream-Ms` (integer, `0` on a hit), `X-Revl-Masked`
(number of distinct values masked), `X-Revl-Retries` (retries actually used).

Upstream status code and body are returned unchanged, including upstream error
responses, so each SDK's own error handling keeps working. Dropped from the
upstream response: `set-cookie`, hop-by-hop headers, any upstream `x-revl-*`
header, and `content-encoding` and `content-length` (the gateway sets its own).

## 6. Exact-match cache

- Storage: KV binding `CACHE`.
- Key: SHA-256 over tenant id, route, SHA-256 of the provider key, the
  `anthropic-version` and `anthropic-beta` header values, and the canonical JSON
  of the body that is sent upstream (object keys sorted recursively).
- Stored only when: the request is not streaming, upstream status is 200, the
  response body is at most 1 MiB, and the body does not contain the caller's
  provider key or gateway key (principle 1: keys never reach storage). Value:
  status, content type and body.
- With masking on, the key is computed over the **masked** body and the stored
  response is the upstream response before rehydration. On a hit the response
  is rehydrated with the current request's mapping. Two prompts that differ
  only in masked values therefore share one cache entry, which is safe because
  the provider never saw the values.

## 7. Masking

Detectors:

- `pii`: email address; phone number (8 to 15 digits written with a
  leading `+`, a bracketed area code, or at least three digit groups; a bare
  run of digits is not treated as a phone number); payment card (13 to 19 digits that pass the Luhn
  check); IPv4 address.
- `secrets`: `sk-ant-...`, `sk-...` and `sk-proj-...` keys; AWS access key ids
  (`AKIA` + 16); GitHub tokens (`ghp_`, `gho_`, `ghu_`, `ghs_`, `ghr_`,
  `github_pat_`); Slack tokens (`xox[baprs]-`); JSON Web Tokens; PEM private
  key blocks.

Where masking is applied: OpenAI `messages[].content` (string, or `text` parts
of an array); Anthropic `system` (string or text blocks) and
`messages[].content` (string, text blocks, and string or text-block content of
`tool_result` blocks). It is not applied to tool definitions, tool call
arguments, or image and document data.

Placeholders look like `<EMAIL_1>`, `<PHONE_1>`, `<CARD_1>`, `<IP_1>`,
`<SECRET_1>`. The same value gets the same placeholder within one request. A
placeholder that already occurs as literal text anywhere in the request body is
never issued (the next free number is used), so rehydration cannot mistake the
caller's own text for a masked value.

Rehydration: placeholders are replaced with the original values in OpenAI
`choices[].message.content` and Anthropic `content[]` text blocks. The mapping
exists only in memory for the duration of the request.

Masking is pattern based. It will miss things and is not a compliance control
by itself. The README and docs must say so.

## 8. Rate limit

Per tenant, through the Workers rate limiting binding `RATE_LIMITER` (default
60 requests per 60 seconds, set in `wrangler.jsonc`). Over the limit:
`429 revl_rate_limited` with `Retry-After: 60`. If the binding is absent the
gateway does not rate limit.

## 9. Limits and errors

- Request body limit: 10 MiB, otherwise `413 revl_payload_too_large`.
- Body must be a JSON object: otherwise `400 revl_bad_request`.
- Upstream could not be reached after all retries: `502 revl_upstream_unreachable`.
- Unexpected failure inside the gateway: `500 revl_internal_error`.
- Every error the gateway itself produces has the shape
  `{"error": {"type": "revl_<code>", "message": "<human readable>"}}` and a
  `X-Revl-Request-Id` header. Messages never contain key material.

## 10. Logging

One `console.log` JSON line per request with: `request_id`, `tenant`, `route`,
`model`, `status`, `cache`, `upstream_ms`, `masked`, `retries`, `stream`. No
bodies, no headers, no key material, no key hashes.

## 11. Not in v0.1 (roadmap, in no committed order)

Semantic (embedding-based) caching. Caching and rehydration for streamed
responses. Cross-provider fallback. Usage dashboard and analytics API. Per-key
budgets and per-key rate limits. SSO and SCIM. Custom masking detectors.
