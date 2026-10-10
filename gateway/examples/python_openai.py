"""Call the OpenAI Chat Completions API through a Revl gateway with your own OpenAI API key.

    pip install openai

    export REVL_BASE_URL=https://<your-gateway>      # no trailing slash needed
    export REVL_API_KEY=<your gateway key>           # omit if the gateway does not require one
    export OPENAI_API_KEY=<your own OpenAI API key>
    python python_openai.py

Run it twice: the second answer comes from the gateway's exact-match cache.
"""

import os

import openai

base_url = os.environ["REVL_BASE_URL"].rstrip("/")

# X-Revl-* headers are options for the gateway. They are never sent to OpenAI.
headers = {"X-Revl-Cache": "exact"}
if os.environ.get("REVL_API_KEY"):
    headers["X-Revl-Key"] = os.environ["REVL_API_KEY"]

client = openai.OpenAI(
    base_url=base_url + "/v1",
    api_key=os.environ["OPENAI_API_KEY"],
    default_headers=headers,
)

completion = client.chat.completions.create(
    model="gpt-4o",
    messages=[{"role": "user", "content": "Explain what an API gateway does in two sentences."}],
)

print(completion.choices[0].message.content)
