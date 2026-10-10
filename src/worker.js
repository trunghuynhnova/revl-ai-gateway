/**
 * Revl AI edge Worker.
 *
 *  - Forces HTTPS and the canonical host (www -> apex) on proxyrevlvay.com.
 *  - POST /api/waitlist stores an email address in the D1 table `waitlist`.
 *  - Everything else is served from the static assets in ./revl-ai.
 *  - Security headers are added to every response.
 */

const CANONICAL_HOST = 'proxyrevlvay.com';
const MAX_BODY_BYTES = 2048;
const MAX_EMAIL_LENGTH = 254;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const SOURCES = new Set(['waitlist', 'api-keys']);

// The pages use the Tailwind Play CDN and inline <script>/<style> blocks, which is
// why 'unsafe-inline' is allowed for scripts and styles. Everything else is locked
// to this origin plus the two font hosts.
const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'Content-Security-Policy': CONTENT_SECURITY_POLICY,
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=()',
};

// Apex only, on purpose: other subdomains of this zone are not served by this
// Worker, so includeSubDomains would break plain-HTTP use of them.
const HSTS = 'max-age=15552000';

function json(body, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  });
}

/** Returns a redirect to https://proxyrevlvay.com/... when the request is not already there. */
function canonicalRedirect(request, url) {
  const host = url.hostname;
  const ours = host === CANONICAL_HOST || host === `www.${CANONICAL_HOST}`;
  if (!ours) return null; // localhost, workers.dev, previews: leave alone
  if (url.protocol === 'https:' && host === CANONICAL_HOST) return null;

  const target = new URL(url.toString());
  target.protocol = 'https:';
  target.hostname = CANONICAL_HOST;
  target.port = '';

  // 308 keeps the method and body for non-GET requests.
  const status = request.method === 'GET' || request.method === 'HEAD' ? 301 : 308;
  return new Response(null, {
    status,
    headers: { Location: target.toString(), 'Cache-Control': 'public, max-age=3600' },
  });
}

/** Reads the request body as text, or returns null if it is larger than maxBytes. */
async function readBodyCapped(request, maxBytes) {
  const declared = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  if (!request.body) return '';

  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

async function handleWaitlist(request, env, url) {
  if (request.method !== 'POST') {
    return json({ ok: false, error: 'method_not_allowed' }, 405, { Allow: 'POST' });
  }

  // Same-origin only. Browsers always send Origin on a cross-site POST.
  const origin = request.headers.get('Origin');
  if (origin && origin !== url.origin) {
    return json({ ok: false, error: 'forbidden' }, 403);
  }

  // Requiring JSON means a cross-site HTML form cannot post here.
  const contentType = (request.headers.get('Content-Type') || '').toLowerCase();
  if (!contentType.startsWith('application/json')) {
    return json({ ok: false, error: 'unsupported_media_type' }, 415);
  }

  if (env.WAITLIST_LIMITER) {
    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    const { success } = await env.WAITLIST_LIMITER.limit({ key: ip });
    if (!success) {
      return json({ ok: false, error: 'rate_limited' }, 429, { 'Retry-After': '60' });
    }
  }

  const text = await readBodyCapped(request, MAX_BODY_BYTES);
  if (text === null) {
    return json({ ok: false, error: 'payload_too_large' }, 413);
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }
  if (data === null || typeof data !== 'object' || Array.isArray(data)) {
    return json({ ok: false, error: 'invalid_json' }, 400);
  }

  // Honeypot: a real visitor never sees or fills this field. Answer as if it
  // worked so a bot gets no signal, but store nothing.
  if (typeof data.hp === 'string' && data.hp.trim() !== '') {
    return json({ ok: true });
  }

  const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
  if (email.length === 0 || email.length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email)) {
    return json({ ok: false, error: 'invalid_email' }, 400);
  }
  const source = SOURCES.has(data.source) ? data.source : 'waitlist';

  try {
    // A repeat signup is a no-op and gets the same answer as a new one, so the
    // endpoint does not reveal whether an address is already on the list.
    await env.DB.prepare(
      'INSERT INTO waitlist (email, source, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(email) DO NOTHING',
    )
      .bind(email, source, new Date().toISOString())
      .run();
  } catch (err) {
    console.error('waitlist insert failed:', err && err.message ? err.message : err);
    return json({ ok: false, error: 'server_error' }, 500);
  }

  return json({ ok: true });
}

function finalize(response, url) {
  const res = new Response(response.body, response);
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    res.headers.set(name, value);
  }
  if (url.protocol === 'https:') {
    res.headers.set('Strict-Transport-Security', HSTS);
  }
  const type = res.headers.get('Content-Type');
  if (type && type.trim().toLowerCase() === 'text/html') {
    res.headers.set('Content-Type', 'text/html; charset=utf-8');
  }
  return res;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    const redirect = canonicalRedirect(request, url);
    if (redirect) return finalize(redirect, url);

    let response;
    try {
      if (url.pathname === '/api/waitlist') {
        response = await handleWaitlist(request, env, url);
      } else if (url.pathname === '/api' || url.pathname.startsWith('/api/')) {
        response = json({ ok: false, error: 'not_found' }, 404);
      } else {
        response = await env.ASSETS.fetch(request);
      }
    } catch (err) {
      console.error('unhandled error:', err && err.message ? err.message : err);
      response = url.pathname.startsWith('/api')
        ? json({ ok: false, error: 'server_error' }, 500)
        : new Response('Internal Server Error', { status: 500 });
    }

    return finalize(response, url);
  },
};
