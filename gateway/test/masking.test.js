// SPEC sections 6 and 7 end to end: where masking is applied on each route,
// rehydration of both response shapes, and masking combined with the cache.

import assert from "node:assert/strict";
import { test } from "node:test";
import { ROUTE_CASES, chatBody, createGateway, messagesBody, reply } from "../testkit/harness.js";

const PII = { "x-revl-mask": "pii" };
const BOTH = { "x-revl-mask": "pii,secrets" };
const CACHED = { "x-revl-mask": "pii", "x-revl-cache": "exact" };
const status = (response) => response.headers.get("x-revl-cache-status");
const jsonReply = (data) => reply(200, JSON.stringify(data));

// Assembled at run time from filler: not credentials.
const SK = "sk-" + "Ab1".repeat(16);
const pem = (body) => `-----BEGIN ${"PRIVATE KEY"}-----\n${body}\n-----END ${"PRIVATE KEY"}-----`;

test("OpenAI: message content is masked as a string and as text parts; nothing else is touched", async () => {
  const gw = createGateway();
  const image = { type: "image_url", image_url: { url: "https://img.example/alice@example.com.png" } };
  const toolCalls = [{ id: "call_1", type: "function", function: { name: "lookup", arguments: '{"email":"alice@example.com"}' } }];
  const tools = [{ type: "function", function: { name: "lookup", description: "Look up alice@example.com", parameters: { type: "object", properties: {} } } }];
  const response = await gw.openai(
    {
      model: "gpt-4o",
      user: "alice@example.com",
      messages: [
        { role: "system", content: "Reply to alice@example.com." },
        { role: "user", content: [{ type: "text", text: "My phone is +1 415 555 0123, again alice@example.com" }, image] },
        { role: "assistant", content: null, tool_calls: toolCalls },
        { role: "tool", tool_call_id: "call_1", content: "found bob@example.org" },
      ],
      tools,
    },
    PII,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-revl-masked"), "3");
  assert.deepEqual(JSON.parse(gw.upstream.calls[0].body), {
    model: "gpt-4o",
    user: "alice@example.com",
    messages: [
      { role: "system", content: "Reply to <EMAIL_1>." },
      { role: "user", content: [{ type: "text", text: "My phone is <PHONE_1>, again <EMAIL_1>" }, image] },
      { role: "assistant", content: null, tool_calls: toolCalls },
      { role: "tool", tool_call_id: "call_1", content: "found <EMAIL_2>" },
    ],
    tools,
  });
  assert.equal(gw.logs[0].masked, 3);
});

test("Anthropic: system, message content and tool_result content are masked; nothing else is touched", async () => {
  const gw = createGateway();
  const toolUse = { type: "tool_use", id: "toolu_1", name: "lookup", input: { email: "alice@example.com" } };
  const image = { type: "image", source: { type: "base64", media_type: "image/png", data: "alice@example.com" } };
  const document = { type: "document", source: { type: "text", media_type: "text/plain", data: "alice@example.com" } };
  const tools = [{ name: "lookup", description: "Finds alice@example.com", input_schema: { type: "object" } }];
  const response = await gw.anthropic(
    {
      model: "claude-opus-5-5",
      max_tokens: 64,
      metadata: { user_id: "alice@example.com" },
      system: [
        { type: "text", text: "Customer: alice@example.com" },
        { type: "text", text: "Server 192.168.1.10", cache_control: { type: "ephemeral" } },
      ],
      messages: [
        { role: "user", content: "Email alice@example.com" },
        { role: "assistant", content: [{ type: "text", text: "Looking up alice@example.com" }, toolUse] },
        {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "toolu_1", content: "Card 4111 1111 1111 1111" },
            { type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "Phone (415) 555-0123" }, image] },
            image,
            document,
            { type: "text", text: "thanks, bob@example.org" },
          ],
        },
      ],
      tools,
    },
    PII,
  );
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("x-revl-masked"), "5");
  assert.deepEqual(JSON.parse(gw.upstream.calls[0].body), {
    model: "claude-opus-5-5",
    max_tokens: 64,
    metadata: { user_id: "alice@example.com" },
    system: [
      { type: "text", text: "Customer: <EMAIL_1>" },
      { type: "text", text: "Server <IP_1>", cache_control: { type: "ephemeral" } },
    ],
    messages: [
      { role: "user", content: "Email <EMAIL_1>" },
      { role: "assistant", content: [{ type: "text", text: "Looking up <EMAIL_1>" }, toolUse] },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "toolu_1", content: "Card <CARD_1>" },
          { type: "tool_result", tool_use_id: "toolu_2", content: [{ type: "text", text: "Phone <PHONE_1>" }, image] },
          image,
          document,
          { type: "text", text: "thanks, <EMAIL_2>" },
        ],
      },
    ],
    tools,
  });
});

test("Anthropic: a system prompt given as a string is masked", async () => {
  const gw = createGateway();
  await gw.anthropic(messagesBody("hello", { system: `Use ${SK} for alice@example.com` }), BOTH);
  assert.equal(JSON.parse(gw.upstream.calls[0].body).system, "Use <SECRET_1> for <EMAIL_1>");
});

test("a masked value never reaches upstream and comes back restored, on both routes", async () => {
  const prompt = `Mail alice@example.com, call +1 415 555 0123, card 4111 1111 1111 1111, host 10.0.0.1, key ${SK}`;
  for (const route of ROUTE_CASES) {
    const gw = createGateway();
    const response = await gw.send(route.path, { headers: route.headers(BOTH), body: route.body(prompt) });
    const [call] = gw.upstream.calls;
    for (const value of ["alice@example.com", "415 555 0123", "4111 1111 1111 1111", "10.0.0.1", SK]) {
      assert.ok(!call.body.includes(value), `${route.name}: ${value} reached upstream`);
    }
    assert.ok(call.body.includes("Mail <EMAIL_1>, call <PHONE_1>, card <CARD_1>, host <IP_1>, key <SECRET_1>"));
    assert.equal(response.headers.get("x-revl-masked"), "5");
    // The fake upstream echoes what it received; the caller sees the original text again.
    assert.ok(route.text(await response.json()).includes(prompt), route.name);
  }
});

test("OpenAI responses: choices[].message.content is rehydrated, other fields are not", async () => {
  const gw = createGateway();
  const upstream = {
    id: "chatcmpl-<EMAIL_1>",
    object: "chat.completion",
    choices: [
      { index: 0, message: { role: "assistant", content: "Dear <EMAIL_1>, we will call <PHONE_1>." }, finish_reason: "stop" },
      { index: 1, message: { role: "assistant", content: "<EMAIL_1> again, and <EMAIL_7> stays." }, finish_reason: "stop" },
      {
        index: 2,
        message: { role: "assistant", content: null, tool_calls: [{ id: "call_1", type: "function", function: { name: "send", arguments: '{"to":"<EMAIL_1>"}' } }] },
        finish_reason: "tool_calls",
      },
    ],
    usage: { prompt_tokens: 12, completion_tokens: 9, total_tokens: 21 },
  };
  gw.upstream.respondWith(jsonReply(upstream));
  const response = await gw.openai(chatBody("Mail alice@example.com or call +1 415 555 0123"), PII);
  const body = await response.json();
  assert.equal(body.choices[0].message.content, "Dear alice@example.com, we will call +1 415 555 0123.");
  assert.equal(body.choices[1].message.content, "alice@example.com again, and <EMAIL_7> stays.");
  // Everything else is exactly what upstream sent.
  assert.deepEqual(body.choices[2], upstream.choices[2]);
  assert.equal(body.id, upstream.id);
  assert.deepEqual(body.usage, upstream.usage);
  assert.equal(response.headers.get("content-type"), "application/json");
});

test("Anthropic responses: content[] text blocks are rehydrated, other blocks are not", async () => {
  const gw = createGateway();
  const upstream = {
    id: "msg_<EMAIL_1>",
    type: "message",
    role: "assistant",
    content: [
      { type: "text", text: "Dear <EMAIL_1>," },
      { type: "tool_use", id: "toolu_1", name: "send", input: { to: "<EMAIL_1>" } },
      { type: "text", text: "we will call <PHONE_1>. <CARD_1> is not ours." },
    ],
    stop_reason: "tool_use",
    usage: { input_tokens: 12, output_tokens: 9 },
  };
  gw.upstream.respondWith(jsonReply(upstream));
  const response = await gw.anthropic(messagesBody("Mail alice@example.com or call +1 415 555 0123"), PII);
  const body = await response.json();
  assert.equal(body.content[0].text, "Dear alice@example.com,");
  assert.deepEqual(body.content[1], upstream.content[1]);
  assert.equal(body.content[2].text, "we will call +1 415 555 0123. <CARD_1> is not ours.");
  assert.equal(body.id, upstream.id);
  assert.deepEqual(body.usage, upstream.usage);
});

test("rehydrated values cannot break the JSON structure of the response", async () => {
  // A masked value full of characters that are special in JSON, HTML and regex replacements.
  const nasty = pem('a "quoted" part, a back\\slash, {"k":[1]}, </script>, $& $1, tab\there, caf\u00e9 \u2028 \ud83d\ude00');
  for (const route of ROUTE_CASES) {
    const gw = createGateway();
    const response = await gw.send(route.path, {
      headers: route.headers({ "x-revl-mask": "secrets" }),
      body: route.body(`Keep this safe:\n${nasty}\nThanks`),
    });
    assert.equal(response.headers.get("x-revl-masked"), "1");
    assert.ok(!gw.upstream.calls[0].body.includes("quoted"));
    const text = await response.text();
    const body = JSON.parse(text);
    assert.ok(route.text(body).includes(`Keep this safe:\n${nasty}\nThanks`), route.name);
    // Same top-level shape as the upstream response: nothing was injected or lost.
    const upstreamShape = route.name === "openai"
      ? ["id", "object", "created", "model", "choices", "usage"]
      : ["id", "type", "role", "model", "content", "stop_reason", "stop_sequence", "usage"];
    assert.deepEqual(Object.keys(body), upstreamShape);
  }
});

test("a 200 response that is not JSON is returned untouched even if it contains a placeholder", async () => {
  const gw = createGateway();
  for (const text of ["plain text for <EMAIL_1>", '"<EMAIL_1>"', '["<EMAIL_1>"]', '{"unrelated":"<EMAIL_1>"}']) {
    gw.upstream.respondWith(reply(200, text, { "content-type": "text/plain" }));
    const response = await gw.openai(chatBody("Mail alice@example.com"), PII);
    assert.equal(await response.text(), text);
  }
});

test("with masking on but nothing to mask, the body is forwarded byte for byte", async () => {
  const gw = createGateway();
  const raw = '{ "model":"gpt-4o", "temperature":1.0,\n "messages":[{"role":"user","content":"nothing sensitive here"}] }';
  const response = await gw.openai(raw, BOTH);
  assert.equal(gw.upstream.calls[0].body, raw);
  assert.equal(response.headers.get("x-revl-masked"), "0");
});

test("with masking off, values are forwarded as they are", async () => {
  const gw = createGateway();
  const raw = JSON.stringify(chatBody(`Mail alice@example.com with ${SK}`));
  for (const headers of [{}, { "x-revl-mask": "off" }]) {
    const response = await gw.openai(raw, headers);
    assert.equal(response.headers.get("x-revl-masked"), "0");
  }
  assert.deepEqual(gw.upstream.calls.map((call) => call.body), [raw, raw]);
});

test("an upstream error is passed through unchanged while masking is on", async () => {
  const gw = createGateway();
  const errorBody = '{"error":{"message":"Could not parse <EMAIL_1>"}}';
  gw.upstream.respondWith(reply(400, errorBody));
  const response = await gw.openai(chatBody("Mail alice@example.com"), PII);
  assert.equal(response.status, 400);
  assert.equal(await response.text(), errorBody);
  assert.equal(response.headers.get("x-revl-masked"), "1");
});

test("two prompts that differ only in masked values share one cache entry, and each caller gets their own values back", async () => {
  for (const route of ROUTE_CASES) {
    const gw = createGateway();
    const ask = (email, card) =>
      gw.send(route.path, { headers: route.headers(CACHED), body: route.body(`Write to ${email} about card ${card}.`) });

    const first = await ask("alice@example.com", "4111 1111 1111 1111");
    const second = await ask("bob@example.org", "5555 5555 5555 4444");
    assert.equal(status(first), "MISS");
    assert.equal(status(second), "HIT");
    assert.equal(gw.upstream.calls.length, 1);
    assert.equal(gw.CACHE.puts.length, 1);
    assert.equal(second.headers.get("x-revl-masked"), "2");

    const firstText = route.text(await first.json());
    const secondText = route.text(await second.json());
    assert.ok(firstText.includes("Write to alice@example.com about card 4111 1111 1111 1111."));
    assert.ok(secondText.includes("Write to bob@example.org about card 5555 5555 5555 4444."));
    assert.ok(!firstText.includes("bob@") && !firstText.includes("5555"));
    assert.ok(!secondText.includes("alice@") && !secondText.includes("4111"));

    // The provider and the cache only ever saw placeholders.
    const everywhere = gw.upstream.calls[0].body + JSON.stringify(gw.CACHE.ops);
    for (const value of ["alice@example.com", "bob@example.org", "4111", "5555"]) {
      assert.ok(!everywhere.includes(value), `${route.name}: ${value} left the gateway`);
    }
    assert.ok(JSON.parse(gw.CACHE.puts[0].value).body.includes("Write to <EMAIL_1> about card <CARD_1>."));
  }
});

test('a prompt that already contains the literal text "<EMAIL_1>" keeps it, and real values get other placeholders', async () => {
  for (const route of ROUTE_CASES) {
    const gw = createGateway();
    const prompt = "Leave the token <EMAIL_1> exactly as written, then write to carol@example.net.";
    const response = await gw.send(route.path, { headers: route.headers(PII), body: route.body(prompt) });
    const sent = gw.upstream.calls[0].body;
    assert.ok(sent.includes("Leave the token <EMAIL_1> exactly as written, then write to <EMAIL_2>."), sent);
    assert.equal(response.headers.get("x-revl-masked"), "1");
    // If carol had been given <EMAIL_1>, the caller's literal would now read "carol@example.net".
    assert.ok(route.text(await response.json()).includes(prompt), route.name);
  }
});

test("a literal placeholder outside the masked fields, or later in the conversation, is respected too", async () => {
  const gw = createGateway();
  // In a tool description (never masked) on the OpenAI route.
  await gw.openai(
    chatBody("Write to carol@example.net.", {
      tools: [{ type: "function", function: { name: "f", description: "Fill in <EMAIL_1> and <EMAIL_2>", parameters: {} } }],
    }),
    PII,
  );
  assert.equal(JSON.parse(gw.upstream.calls[0].body).messages[0].content, "Write to <EMAIL_3>.");

  // In a later message than the value, on the Anthropic route, written with a JSON escape.
  const raw = '{"model":"claude-opus-5-5","max_tokens":64,"messages":[{"role":"user","content":"Write to carol@example.net."},{"role":"assistant","content":"ok"},{"role":"user","content":"and keep \\u003cEMAIL_1> as is"}]}';
  const response = await gw.anthropic(raw, PII);
  const sent = JSON.parse(gw.upstream.calls[1].body);
  assert.equal(sent.messages[0].content, "Write to <EMAIL_2>.");
  assert.equal(sent.messages[2].content, "and keep <EMAIL_1> as is");
  const text = (await response.json()).content[0].text;
  assert.ok(text.includes("Write to carol@example.net."));
  assert.ok(text.includes("and keep <EMAIL_1> as is"));
});

test("a literal placeholder never causes another caller's value, or a wrong value, to be substituted", async () => {
  for (const route of ROUTE_CASES) {
    const gw = createGateway();
    const ask = (text) => gw.send(route.path, { headers: route.headers(CACHED), body: route.body(text) });
    const reply1 = async (response) => route.text(await response.json());

    // Caller 1 writes the placeholder literally. Caller 2's prompt masks to the very same text,
    // so both share one cache entry.
    const literal = await ask("Write to <EMAIL_1> today.");
    const dave = await ask("Write to dave@example.com today.");
    const erin = await ask("Write to erin@example.org today.");
    const literalAgain = await ask("Write to <EMAIL_1> today.");
    assert.deepEqual([literal, dave, erin, literalAgain].map(status), ["MISS", "HIT", "HIT", "HIT"]);
    assert.equal(gw.upstream.calls.length, 1);

    assert.ok((await reply1(literal)).includes("Write to <EMAIL_1> today."));
    assert.ok((await reply1(dave)).includes("Write to dave@example.com today."));
    assert.ok((await reply1(erin)).includes("Write to erin@example.org today."));
    // After two other callers hit the entry, the literal caller still gets the literal: no value leaked in.
    const again = await reply1(literalAgain);
    assert.ok(again.includes("Write to <EMAIL_1> today."));
    assert.ok(!again.includes("dave@") && !again.includes("erin@"));
    assert.ok(!JSON.stringify(gw.CACHE.ops).includes("dave@") && !JSON.stringify(gw.CACHE.ops).includes("erin@"));
  }
});

test("a caller who mixes a literal placeholder with a real value shares nothing with a caller who has two values", async () => {
  const gw = createGateway();
  const ask = (text) => gw.openai(chatBody(text), CACHED);
  const mixed = await ask("Tell <EMAIL_1> about frank@example.com.");
  const two = await ask("Tell gina@example.org about hugo@example.net.");
  // Both prompts mask to "Tell <EMAIL_1> about <EMAIL_2>." and the provider saw only that.
  assert.deepEqual([status(mixed), status(two)], ["MISS", "HIT"]);
  assert.equal(JSON.parse(gw.upstream.calls[0].body).messages[0].content, "Tell <EMAIL_1> about <EMAIL_2>.");
  assert.ok((await mixed.json()).choices[0].message.content.includes("Tell <EMAIL_1> about frank@example.com."));
  assert.ok((await two.json()).choices[0].message.content.includes("Tell gina@example.org about hugo@example.net."));
});

test("masked and unmasked requests for different text never collide in the cache", async () => {
  const gw = createGateway();
  const withMask = await gw.openai(chatBody("Write to alice@example.com"), CACHED);
  const withoutMask = await gw.openai(chatBody("Write to alice@example.com"), { "x-revl-cache": "exact" });
  assert.deepEqual([status(withMask), status(withoutMask)], ["MISS", "MISS"]);
  assert.equal(gw.upstream.calls[0].body.includes("alice@example.com"), false);
  assert.equal(gw.upstream.calls[1].body.includes("alice@example.com"), true);
});
