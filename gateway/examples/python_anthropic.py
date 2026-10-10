"""Call the Anthropic Messages API through a Revl gateway with your own Anthropic API key.

    pip install anthropic

    export REVL_BASE_URL=https://<your-gateway>      # no trailing slash needed
    export REVL_API_KEY=<your gateway key>           # omit if the gateway does not require one
    export ANTHROPIC_API_KEY=<your own Anthropic API key>
    python python_anthropic.py

Run it twice: the second answer comes from the gateway's exact-match cache.
"""

import os

import anthropic

base_url = os.environ["REVL_BASE_URL"].rstrip("/")

# X-Revl-* headers are options for the gateway. They are never sent to Anthropic.
headers = {"X-Revl-Cache": "exact"}
if os.environ.get("REVL_API_KEY"):
    headers["X-Revl-Key"] = os.environ["REVL_API_KEY"]

client = anthropic.Anthropic(
    base_url=base_url,
    api_key=os.environ["ANTHROPIC_API_KEY"],
    default_headers=headers,
)

response = client.messages.create(
    model="claude-opus-5-5",
    max_tokens=16000,
    messages=[{"role": "user", "content": "Explain what an API gateway does in two sentences."}],
)

if response.stop_reason == "refusal":
    print("The model declined this request.")
for block in response.content:
    if block.type == "text":
        print(block.text)
