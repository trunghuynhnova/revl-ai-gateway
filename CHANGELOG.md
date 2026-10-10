# Changelog

All notable changes to this project are recorded here. Dates are UTC.

## Gateway 0.1.0 (2026-10-11)

First public version of the open-source gateway core.

- BYOK passthrough for the Anthropic Messages API and the OpenAI Chat
  Completions API in their native wire formats.
- Gateway access keys, stored only as SHA-256 hashes.
- Exact-match response cache, opt-in per request, isolated per tenant and per
  provider key.
- PII and secret masking with rehydration for non-streaming requests.
- Retries with backoff, per-tenant rate limiting, streaming passthrough.
- Metadata-only request logging.

## Website (2026-10-11)

- Documentation, simulated demo dashboard and About page.
- robots.txt, sitemap.xml, security.txt, structured data and social preview.

## Website (2026-10-10)

- Landing page, privacy policy and terms of service.
- Waitlist endpoint backed by Cloudflare D1, HTTPS redirect and security
  headers, custom 404 page.
