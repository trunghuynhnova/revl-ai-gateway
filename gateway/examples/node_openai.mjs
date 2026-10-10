// Call the OpenAI Chat Completions API through a Revl gateway with your own OpenAI API key.
//
//   npm install openai
//
//   export REVL_BASE_URL=https://<your-gateway>      # no trailing slash needed
//   export REVL_API_KEY=<your gateway key>           # omit if the gateway does not require one
//   export OPENAI_API_KEY=<your own OpenAI API key>
//   node node_openai.mjs
//
// Run it twice: the second answer comes from the gateway's exact-match cache.

import OpenAI from "openai";

const { REVL_BASE_URL, REVL_API_KEY, OPENAI_API_KEY } = process.env;
if (!REVL_BASE_URL || !OPENAI_API_KEY) {
  console.error("Set REVL_BASE_URL and OPENAI_API_KEY first.");
  process.exit(1);
}

// X-Revl-* headers are options for the gateway. They are never sent to OpenAI.
const defaultHeaders = { "X-Revl-Cache": "exact" };
if (REVL_API_KEY) defaultHeaders["X-Revl-Key"] = REVL_API_KEY;

const client = new OpenAI({
  baseURL: `${REVL_BASE_URL.replace(/\/+$/, "")}/v1`,
  apiKey: OPENAI_API_KEY,
  defaultHeaders,
});

const completion = await client.chat.completions.create({
  model: "gpt-4o",
  messages: [{ role: "user", content: "Explain what an API gateway does in two sentences." }],
});

console.log(completion.choices[0].message.content);
