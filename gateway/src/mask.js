// Pattern-based masking. It will miss things: see "Masking limitations" in the README.
//
// Every pattern must stay linear, and must not exhaust the regex stack, on
// hostile input: it runs over request bodies of up to 10 MiB. Two rules keep it
// that way. A lookbehind pins each match to the start of its run of characters,
// and every repetition is bounded (test/mask.test.js times the worst cases).

const SECRET_PATTERNS = [
  // PEM private key block. The body stops at the next BEGIN marker.
  /-----BEGIN [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----(?:(?!-----BEGIN )[\s\S])*?-----END [A-Z ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g,
  // JSON Web Token: header and payload both start with base64url of `{"`.
  /(?<![\w-])eyJ[\w-]{8,2048}\.eyJ[\w-]{8,16384}\.[\w-]{8,2048}/g,
  // sk-..., sk-proj-... and sk-ant-... keys. A digit is required so that
  // hyphenated prose starting with "sk-" is left alone.
  /(?<![\w-])sk-(?=[\w-]{0,255}\d)[\w-]{20,256}/g,
  // AWS access key id.
  /(?<![A-Z0-9])AKIA[A-Z0-9]{16}(?![A-Z0-9])/g,
  // GitHub tokens.
  /(?<![\w-])(?:gh[pousr]_[A-Za-z0-9]{36,255}|github_pat_\w{22,255})/g,
  // Slack tokens.
  /(?<![\w-])xox[baprs]-[A-Za-z0-9-]{10,255}/g,
];

const EMAIL = /(?<![\w.%+-])[\w.%+-]{1,64}@(?:[A-Za-z0-9-]{1,63}\.){1,8}[A-Za-z]{2,24}/g;

// Contiguous digits, or the usual printed groupings (4-4-4-n and 4-6-n).
const CARD =
  /(?<![\w.])(?:\d{13,19}|\d{4}([ -])\d{4}\1\d{4}\1\d{1,4}|\d{4}([ -])\d{6}\2\d{4,5})(?!\w|\.\d)/g;

const OCTET = "(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)";
const IPV4 = new RegExp(`(?<![\\w.])${OCTET}(?:\\.${OCTET}){3}(?!\\w|\\.\\d)`, "g");

// Optional +country code, optional (area code), then digits with single
// separators. isPhone() decides whether a candidate really is a phone number.
const PHONE =
  /(?<![\w+])(?<!\d[ .-])(?:\+\d{1,3}[ .-]?)?(?:\(\d{1,4}\)[ .-]?)?\d(?:[ .-]?\d){4,18}/g;
const DATE_LIKE = /^(?:\d{4}[.-]\d{2}[.-]\d{2}|\d{2}[.-]\d{2}[.-]\d{4})(?!\d)/;

/** @param {string} candidate */
function passesLuhn(candidate) {
  const digits = candidate.replace(/\D/g, "");
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let digit = digits.charCodeAt(digits.length - 1 - i) - 48;
    if (i % 2 === 1 && (digit *= 2) > 9) digit -= 9;
    sum += digit;
  }
  return sum % 10 === 0;
}

/**
 * 8 to 15 digits, and something that marks it as a phone number rather than an
 * order number, id or date: a leading +, a parenthesised area code, or at
 * least three digit groups.
 * @param {string} candidate
 */
function isPhone(candidate) {
  const digitCount = candidate.replace(/\D/g, "").length;
  if (digitCount < 8 || digitCount > 15) return false;
  if (candidate.startsWith("+") || candidate.startsWith("(")) return true;
  if (DATE_LIKE.test(candidate)) return false;
  const groups = candidate.split(/[ .-]/);
  return groups.length >= 3 && groups.slice(1).every((group) => group.length >= 2);
}

/** @type {Record<string, Array<[label: string, pattern: RegExp, accept?: (match: string) => boolean]>>} */
const DETECTORS = {
  secrets: SECRET_PATTERNS.map((pattern) => ["SECRET", pattern]),
  // Order matters: a card or an IP address would otherwise be read as a phone number.
  pii: [
    ["EMAIL", EMAIL],
    ["CARD", CARD, passesLuhn],
    ["IP", IPV4],
    ["PHONE", PHONE, isPhone],
  ],
};

export const MASK_KINDS = Object.keys(DETECTORS);
export const PLACEHOLDER = /<(?:EMAIL|PHONE|CARD|IP|SECRET)_\d+>/g;

/** Holds the value-to-placeholder mapping for one request. Never persisted. */
export class Masker {
  /** @param {string[]} kinds Any of MASK_KINDS. */
  constructor(kinds) {
    this.detectors = MASK_KINDS.filter((kind) => kinds.includes(kind)).flatMap((kind) => DETECTORS[kind]);
    /** @type {Map<string, string>} */
    this.placeholders = new Map();
    /** @type {Map<string, string>} */
    this.originals = new Map();
    /** @type {Record<string, number>} */
    this.counters = {};
    /** @type {Set<string>} Placeholder-shaped text the caller wrote literally. */
    this.reserved = new Set();
  }

  /**
   * Call with all the text of a request before mask(). A placeholder the caller
   * already wrote literally is never handed out, so rehydration cannot mistake
   * the caller's own text for a masked value.
   * @param {string} text
   */
  reserve(text) {
    for (const [literal] of text.matchAll(PLACEHOLDER)) this.reserved.add(literal);
  }

  /** Number of distinct values masked so far. */
  get count() {
    return this.placeholders.size;
  }

  /** @param {string} text */
  mask(text) {
    for (const [label, pattern, accept] of this.detectors) {
      text = text.replace(pattern, (match) =>
        !accept || accept(match) ? this.placeholderFor(label, match) : match,
      );
    }
    return text;
  }

  /** Restores original values. Placeholders this request did not create are left alone. */
  rehydrate(/** @type {string} */ text) {
    return text.replace(PLACEHOLDER, (placeholder) => this.originals.get(placeholder) ?? placeholder);
  }

  /**
   * @param {string} label
   * @param {string} value
   */
  placeholderFor(label, value) {
    let placeholder = this.placeholders.get(value);
    if (!placeholder) {
      do {
        this.counters[label] = (this.counters[label] ?? 0) + 1;
        placeholder = `<${label}_${this.counters[label]}>`;
      } while (this.reserved.has(placeholder));
      this.placeholders.set(value, placeholder);
      this.originals.set(placeholder, value);
    }
    return placeholder;
  }
}
