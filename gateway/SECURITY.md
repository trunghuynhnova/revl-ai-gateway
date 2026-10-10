# Security policy

## Reporting a vulnerability

Please report security problems privately, by email to
**founder@proxyrevlvay.com**. Do not open a public issue for them.

A useful report includes:

- what is affected: the route, header or source file, and the version or
  commit you tested;
- the steps to reproduce it, ideally a request that shows the problem
  (`curl` is fine) or a failing test;
- what an attacker could gain, for example another tenant's cached response
  or a provider key;
- whether you saw it on a deployment you run yourself or on the hosted
  gateway.

Never include real provider API keys, gateway keys or other people's data in a
report. Placeholder values are enough.

Please give us a reasonable chance to fix the problem before you publish
details.

## What to expect

Revl AI is an early-stage, founder-led project. Reports are read and taken
seriously, but there is no bug bounty and no guaranteed response time.

## Scope

In scope: the code in this repository, in particular anything that would break
one of these properties from [SPEC.md](SPEC.md):

- a provider key is never stored, logged or returned in an error;
- `X-Revl-*` headers and gateway keys never reach a provider;
- a cache entry is never served to another tenant or another provider key;
- the gateway only ever fetches its two configured upstream URLs.

Out of scope: vulnerabilities in Cloudflare, Anthropic or OpenAI services
(report those to the vendor), and the documented limits of pattern-based
masking described in the README.
