// Call the Anthropic Messages API through a Revl gateway with your own Anthropic API key.
//
//   npm install @anthropic-ai/sdk
//
//   export REVL_BASE_URL=https://<your-gateway>      # no trailing slash needed
//   export REVL_API_KEY=<your gateway key>           # omit if the gateway does not require one
//   export ANTHROPIC_API_KEY=<your own Anthropic API key>
//   node node_anthropic.mjs
//
// Run it twice: the second answer comes from the gateway's exact-match cache.

import Anthropic from "@anthropic-ai/sdk";

const { REVL_BASE_URL, REVL_API_KEY, ANTHROPIC_API_KEY } = process.env;
if (!REVL_BASE_URL || !ANTHROPIC_API_KEY) {
  console.error("Set REVL_BASE_URL and ANTHROPIC_API_KEY first.");
  process.exit(1);
}

// X-Revl-* headers are options for the gateway. They are never sent to Anthropic.
const defaultHeaders = { "X-Revl-Cache": "exact" };
if (REVL_API_KEY) defaultHeaders["X-Revl-Key"] = REVL_API_KEY;

const client = new Anthropic({
  baseURL: REVL_BASE_URL.replace(/\/+$/, ""), // the SDK appends /v1/messages
  apiKey: ANTHROPIC_API_KEY,
  defaultHeaders,
});

const response = await client.messages.create({
  model: "claude-opus-5-5",
  max_tokens: 16000,
  messages: [{ role: "user", content: "Explain what an API gateway does in two sentences." }],
});

if (response.stop_reason === "refusal") console.log("The model declined this request.");
for (const block of response.content) {
  if (block.type === "text") console.log(block.text);
}
