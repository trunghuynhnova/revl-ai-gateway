#!/usr/bin/env bash
# Call a Revl gateway with curl and print the response headers, so the
# X-Revl-* headers are visible. Run it twice to see X-Revl-Cache-Status go
# from MISS to HIT. The prompt contains an email address: with X-Revl-Mask: pii
# the provider receives a placeholder and X-Revl-Masked reports 1.
#
#   export REVL_BASE_URL=https://<your-gateway>      # no trailing slash needed
#   export REVL_API_KEY=<your gateway key>           # omit if the gateway does not require one
#   export OPENAI_API_KEY=<your own OpenAI API key>          # either of these,
#   export ANTHROPIC_API_KEY=<your own Anthropic API key>    # or both
#   bash curl.sh
set -euo pipefail

: "${REVL_BASE_URL:?Set REVL_BASE_URL to the URL of your gateway}"
base="${REVL_BASE_URL%/}"
prompt="Write a one-line reply to jane@example.com."

if [ -z "${OPENAI_API_KEY:-}" ] && [ -z "${ANTHROPIC_API_KEY:-}" ]; then
  echo "Set OPENAI_API_KEY or ANTHROPIC_API_KEY (your own provider key) first." >&2
  exit 1
fi

echo "== GET /healthz"
curl -sS "${base}/healthz"
echo

# curl sends no header at all for an empty value, so an unset REVL_API_KEY is fine here.
if [ -n "${OPENAI_API_KEY:-}" ]; then
  echo "== POST /v1/chat/completions"
  curl -sS -i "${base}/v1/chat/completions" \
    -H "X-Revl-Key: ${REVL_API_KEY:-}" \
    -H "Authorization: Bearer ${OPENAI_API_KEY}" \
    -H "Content-Type: application/json" \
    -H "X-Revl-Cache: exact" \
    -H "X-Revl-Mask: pii" \
    -d "{\"model\":\"gpt-4o\",\"messages\":[{\"role\":\"user\",\"content\":\"${prompt}\"}]}"
  echo
fi

if [ -n "${ANTHROPIC_API_KEY:-}" ]; then
  echo "== POST /v1/messages"
  curl -sS -i "${base}/v1/messages" \
    -H "X-Revl-Key: ${REVL_API_KEY:-}" \
    -H "x-api-key: ${ANTHROPIC_API_KEY}" \
    -H "anthropic-version: 2023-06-01" \
    -H "Content-Type: application/json" \
    -H "X-Revl-Cache: exact" \
    -H "X-Revl-Mask: pii" \
    -d "{\"model\":\"claude-opus-5-5\",\"max_tokens\":16000,\"messages\":[{\"role\":\"user\",\"content\":\"${prompt}\"}]}"
  echo
fi
