// SPEC section 7: every detector, with at least one value it must catch and
// one look-alike it must leave alone. Also the worst-case timings that the
// comment at the top of src/mask.js refers to.
//
// Secret-shaped test values are assembled at run time from filler, so that no
// token-shaped literal sits in this file. None of them is a real credential.

import assert from "node:assert/strict";
import { test } from "node:test";
import { MASK_KINDS, Masker } from "../src/mask.js";

const pii = (text) => new Masker(["pii"]).mask(text);
const secrets = (text) => new Masker(["secrets"]).mask(text);

/** Asserts that `value` is replaced as a whole by the first placeholder of `label`. */
function caught(mask, label, value) {
  assert.equal(mask(`before ${value} after`), `before <${label}_1> after`, value);
}

/** Asserts that the text comes back untouched. */
function untouched(mask, text) {
  assert.equal(mask(text), text);
}

/** Appends the Luhn check digit to a run of digits. */
function withCheckDigit(digits) {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 0 && (digit *= 2) > 9) digit -= 9;
    sum += digit;
  }
  return digits + String((10 - (sum % 10)) % 10);
}

test("the two mask kinds are pii and secrets", () => {
  assert.deepEqual([...MASK_KINDS].sort(), ["pii", "secrets"]);
});

test("pii: email addresses", () => {
  for (const email of ["alice@example.com", "first.last+tag@mail.example.co.uk", "a_b-c%d@sub-domain.example.org", "X@Y.IO"]) {
    caught(pii, "EMAIL", email);
  }
  assert.equal(pii("Write to <alice@example.com>."), "Write to <<EMAIL_1>>.");
  for (const text of ["alice@localhost", "@handle and #tag", "a @ b.com", "user@", "alice at example dot com", "price@", "50% @ 3.5"]) {
    untouched(pii, text);
  }
});

test("pii: phone numbers, international and national, with common separators", () => {
  const phones = [
    "+1 415 555 0123",
    "+1-415-555-0123",
    "+1 (415) 555-0123",
    "+442079460123",
    "+44 20 7946 0958",
    "(415) 555-0123",
    "(020) 7946 0123",
    "415-555-0123",
    "415.555.0123",
    "0912 345 678",
  ];
  for (const phone of phones) caught(pii, "PHONE", phone);
  assert.equal(pii("Call 415-555-0123."), "Call <PHONE_1>.");
});

test("pii: a short order number, an id or a date is not a phone number", () => {
  const texts = [
    "Order #48213 has shipped",
    "order 1234567",
    "ticket 12345678",
    "invoice 2024001234",
    "ref 123-4567",
    "ref 1234-5678",
    "released on 2024-01-15",
    "released on 15.01.2024 at 10:30:45",
    "2024-01-15 10:30",
    "sizes 1 2 3 4 5 6 7 8",
    "version 10.15.7 build 2301",
    "pi is 3.14159265",
    "total $1,299.00",
    "+1",
    "+12 34",
    "id 12345678901234567890",
    "room 101, floor 12",
  ];
  for (const text of texts) untouched(pii, text);
});

test("pii: payment cards are 13 to 19 digits that pass the Luhn check", () => {
  const cards = [
    "4111111111111111",
    "4111 1111 1111 1111",
    "4111-1111-1111-1111",
    "5555555555554444",
    "378282246310005",
    "3782 822463 10005",
    "4222222222222",
    withCheckDigit("620000000000000000"),
  ];
  assert.equal(cards.at(-1).length, 19);
  for (const card of cards) caught(pii, "CARD", card);
});

test("pii: a 16-digit number that fails the Luhn check is not masked at all", () => {
  for (const text of [
    "4111111111111112",
    "4111 1111 1111 1112",
    "4111-1111-1111-1112",
    "1234567812345678",
    "tracking 9400100000000000000001",
    // Passes Luhn, but 12 and 20 digits are not card lengths.
    `id ${withCheckDigit("41111111111")}`,
    `id ${withCheckDigit("4111111111111111111")}`,
    // Passes Luhn, but is part of a longer token.
    "ref-ID4111111111111111X",
    "4111111111111111.50",
  ]) {
    untouched(pii, text);
  }
});

test("pii: IPv4 addresses", () => {
  for (const ip of ["192.168.1.10", "8.8.8.8", "255.255.255.255", "10.0.0.1", "0.0.0.0"]) caught(pii, "IP", ip);
  assert.equal(pii("Listening on 10.0.0.1:8080."), "Listening on <IP_1>:8080.");
  assert.equal(pii("ping 192.168.1.10."), "ping <IP_1>.");
  for (const text of ["256.1.1.1", "1.2.3", "v1.2.3.4.5", "1.2.3.4.5", "section 1.2.3.4a", "10.0.0", "3.14159", "1.2.3.4567"]) {
    untouched(pii, text);
  }
});

const filler = (unit, times) => unit.repeat(times);
const SK = "sk-" + filler("Ab1", 16);
const SK_PROJ = "sk-proj-" + filler("Cd2", 16);
const SK_ANT = "sk-ant-api03-" + filler("Ef3", 16);
const AWS_ID = "AKIA" + filler("EXAMPLE7", 2);
const GITHUB = ["ghp_", "gho_", "ghu_", "ghs_", "ghr_"].map((prefix) => prefix + filler("Gh4", 12));
const GITHUB_PAT = "github_pat_" + filler("Ij5_", 8);
const SLACK = ["b", "a", "p", "r", "s"].map((kind) => `xox${kind}-` + "123456-" + filler("Kl6", 4));
const JWT = ["eyJ" + "hbGciOiJIUzI1NiJ9", "eyJ" + "zdWIiOiJleGFtcGxlIn0", "ZXhhbXBsZS1zaWc"].join(".");
const pem = (kind, body = "TUlJRXhhbXBsZQ==\nbm90LWEtcmVhbC1rZXk=") =>
  `-----BEGIN ${kind}-----\n${body}\n-----END ${kind}-----`;

test("secrets: sk-, sk-proj- and sk-ant- keys", () => {
  for (const key of [SK, SK_PROJ, SK_ANT]) caught(secrets, "SECRET", key);
  assert.equal(secrets(`Authorization: Bearer ${SK}`), "Authorization: Bearer <SECRET_1>");
  for (const text of [
    "the sk-learn-style-hyphenated-words-here package",
    "sk-1234",
    "sk-",
    "task-1234567890123456789012345",
    "risk-0000000000000000000000000",
  ]) {
    untouched(secrets, text);
  }
});

test("secrets: AWS access key ids", () => {
  caught(secrets, "SECRET", AWS_ID);
  for (const text of [AWS_ID.slice(0, -1), `${AWS_ID}X`, `X${AWS_ID}`, AWS_ID.toLowerCase(), "AKIA and nothing else"]) {
    untouched(secrets, text);
  }
});

test("secrets: GitHub tokens", () => {
  for (const token of [...GITHUB, GITHUB_PAT]) caught(secrets, "SECRET", token);
  for (const text of ["ghp_tooshort123", "ghx_" + filler("Gh4", 12), "github_pat_short", "my_ghp_" + filler("Gh4", 12)]) {
    untouched(secrets, text);
  }
});

test("secrets: Slack tokens", () => {
  for (const token of SLACK) caught(secrets, "SECRET", token);
  for (const text of ["xoxb-short", "xoxz-" + "123456-" + filler("Kl6", 4), "xox-" + filler("Kl6", 6), "foxoxb-" + filler("Kl6", 6)]) {
    untouched(secrets, text);
  }
});

test("secrets: JSON Web Tokens", () => {
  caught(secrets, "SECRET", JWT);
  const [header, payload] = JWT.split(".");
  for (const text of [`${header}.${payload}`, header, "a.b.c", "eyJ.eyJ.sig", `${header}.notpayload0000.c2lnbmF0dXJl`]) {
    untouched(secrets, text);
  }
});

test("secrets: PEM private key blocks", () => {
  for (const kind of ["PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY", "OPENSSH PRIVATE KEY", "ENCRYPTED PRIVATE KEY", "PGP PRIVATE KEY BLOCK"]) {
    const block = pem(kind);
    assert.equal(secrets(`key:\n${block}\nend`), "key:\n<SECRET_1>\nend", kind);
  }
  for (const text of [
    pem("CERTIFICATE"),
    pem("PUBLIC KEY"),
    "-----BEGIN " + "PRIVATE KEY-----\nTUlJRXhhbXBsZQ==\n(no end marker)",
    "The words PRIVATE KEY in a sentence.",
  ]) {
    untouched(secrets, text);
  }
});

test("each kind masks only its own detectors", () => {
  const text = `mail alice@example.com with ${SK}`;
  assert.equal(pii(text), `mail <EMAIL_1> with ${SK}`);
  assert.equal(secrets(text), "mail alice@example.com with <SECRET_1>");
  assert.equal(new Masker(["pii", "secrets"]).mask(text), "mail <EMAIL_1> with <SECRET_1>");
  assert.equal(new Masker(["secrets", "pii"]).mask(text), "mail <EMAIL_1> with <SECRET_1>");
  assert.equal(new Masker([]).mask(text), text);
});

test("digits inside a secret are not picked up again as a card or a phone number", () => {
  const key = "sk-" + "4111111111111111" + "-" + "4155550123" + "-abcdef";
  const masker = new Masker(["pii", "secrets"]);
  assert.equal(masker.mask(`use ${key} now`), "use <SECRET_1> now");
  assert.equal(masker.count, 1);
});

test("the same value gets the same placeholder within one request", () => {
  const masker = new Masker(["pii", "secrets"]);
  assert.equal(
    masker.mask("alice@example.com, bob@example.org, alice@example.com, 10.0.0.1"),
    "<EMAIL_1>, <EMAIL_2>, <EMAIL_1>, <IP_1>",
  );
  // A later field of the same request reuses the mapping.
  assert.equal(masker.mask(`bob@example.org and ${SK} and carol@example.net`), "<EMAIL_2> and <SECRET_1> and <EMAIL_3>");
  assert.equal(masker.count, 5);
  // A different request starts again from 1.
  assert.equal(new Masker(["pii"]).mask("bob@example.org"), "<EMAIL_1>");
});

test("rehydrate restores every original value and leaves foreign placeholders alone", () => {
  const masker = new Masker(["pii", "secrets"]);
  const original = `Mail alice@example.com or call +1 415 555 0123, card 4111 1111 1111 1111, host 10.0.0.1, key ${SK}`;
  const masked = masker.mask(original);
  assert.equal(masked, "Mail <EMAIL_1> or call <PHONE_1>, card <CARD_1>, host <IP_1>, key <SECRET_1>");
  assert.equal(masker.rehydrate(masked), original);
  assert.equal(masker.rehydrate("<EMAIL_1> <EMAIL_2> <PHONE_9> <NAME_1> <email_1>"), "alice@example.com <EMAIL_2> <PHONE_9> <NAME_1> <email_1>");
});

test("rehydrate is a single pass: a restored value is never expanded again", () => {
  const masker = new Masker(["secrets", "pii"]);
  // The PEM body contains regex replacement patterns and the very placeholder
  // that the email address is about to be given.
  const block = pem("PRIVATE KEY", "line with <EMAIL_1> and $& and $1 and $<x>");
  const masked = masker.mask(`${block} for alice@example.com`);
  assert.equal(masked, "<SECRET_1> for <EMAIL_1>");
  assert.equal(masker.rehydrate(masked), `${block} for alice@example.com`);
});

test("a placeholder the caller already wrote is reserved and never handed out", () => {
  const masker = new Masker(["pii"]);
  masker.reserve('{"messages":[{"content":"keep <EMAIL_1> and <EMAIL_3> and <PHONE_1> literally"}]}');
  const masked = masker.mask("keep <EMAIL_1> and <EMAIL_3> and <PHONE_1> literally; mail a@example.com, b@example.com, c@example.com, call +1 415 555 0123");
  assert.equal(masked, "keep <EMAIL_1> and <EMAIL_3> and <PHONE_1> literally; mail <EMAIL_2>, <EMAIL_4>, <EMAIL_5>, call <PHONE_2>");
  // The caller's literals survive rehydration; only real placeholders are restored.
  assert.equal(
    masker.rehydrate("<EMAIL_1> <EMAIL_2> <EMAIL_3> <EMAIL_4> <PHONE_1> <PHONE_2>"),
    "<EMAIL_1> a@example.com <EMAIL_3> b@example.com <PHONE_1> +1 415 555 0123",
  );
});

test("hostile input stays fast: every pattern is linear", { timeout: 120_000 }, () => {
  const MB = 1024 * 1024;
  const inputs = {
    "long word": "a".repeat(2 * MB),
    "long digit run": "1".repeat(2 * MB),
    "digits and spaces": "1 ".repeat(MB),
    "digits and dashes": "1-".repeat(MB),
    "plus signs": "+1".repeat(MB),
    "parentheses": "(1)".repeat(MB / 2),
    "dotted digits": "1.".repeat(MB),
    "card-like groups": "4111 ".repeat(MB / 4),
    "at signs": "a@".repeat(MB),
    "dotted local part": "a.".repeat(MB) + "@",
    "almost emails": ("a".repeat(64) + "@" + "b.".repeat(8) + " ").repeat(20_000),
    "almost a JWT": "eyJ" + "a".repeat(2 * MB),
    "many almost JWTs": ("eyJ" + "a".repeat(2000) + ".eyJ" + "a".repeat(2000) + " ").repeat(500),
    "almost an sk- key": "sk-" + "a".repeat(2 * MB),
    "many sk- prefixes": "sk-".repeat(MB / 2),
    "unterminated PEM": "-----BEGIN " + "PRIVATE KEY-----" + "x".repeat(2 * MB),
    "many PEM openings": ("-----BEGIN " + "PRIVATE KEY-----" + "x".repeat(100)).repeat(20_000),
    "PEM label padding": ("-----BEGIN " + "A ".repeat(20)).repeat(50_000),
    "PEM end look-alikes": "-----BEGIN " + "PRIVATE KEY-----" + ("-----END " + "A ".repeat(20)).repeat(50_000),
  };
  for (const [name, text] of Object.entries(inputs)) {
    const masker = new Masker(["pii", "secrets"]);
    const started = performance.now();
    masker.mask(text);
    const elapsed = performance.now() - started;
    assert.ok(elapsed < 5000, `${name}: ${Math.round(elapsed)} ms for ${text.length} characters`);
  }
});

test("a multi-megabyte PEM block is masked without exhausting the regex stack", () => {
  const block = pem("RSA PRIVATE KEY", "QUJD\n".repeat(600_000));
  assert.ok(block.length > 2_900_000);
  const masker = new Masker(["secrets"]);
  assert.equal(masker.mask(`a ${block} b`), "a <SECRET_1> b");
  assert.equal(masker.rehydrate("<SECRET_1>"), block);
});
