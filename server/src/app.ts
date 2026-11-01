import {
  ALLOWED_TTL_SECONDS,
  type CreateSecretResponse,
  type GetSecretResponse,
  ID_BYTES,
  isValidId,
  MAX_BODY_BYTES,
  MAX_VIEWS,
  MIN_VIEWS,
  randomBytes,
  REVOKE_TOKEN_BYTES,
  sha256B64Url,
  toBase64Url,
  validateEnvelope,
} from '@envdrop/shared';
import { apiError, json, PAGE_CSP, withSecurityHeaders } from './headers';
import type { RateBucket, RateLimiter } from './rateLimit';
import { type SecretStore, StoreFullError } from './store';

export interface WebAssets {
  /** /s/:id decrypt page */
  html: string;
  /** / landing page */
  landing?: string;
  js: string;
  css: string;
  logo?: string;
}

export interface AppDeps {
  store: SecretStore;
  rateLimiter: RateLimiter;
  /** Static decrypt page. Omit to disable the web fallback. */
  assets?: WebAssets;
  now?: () => number;
}

export type Handler = (request: Request) => Promise<Response>;

class BodyTooLarge extends Error {}

async function readBodyLimited(req: Request, limit: number): Promise<string> {
  const declared = req.headers.get('Content-Length');
  if (declared !== null && Number(declared) > limit) throw new BodyTooLarge();
  if (!req.body) return '';
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new BodyTooLarge();
    }
    chunks.push(value);
  }
  const buf = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    buf.set(c, off);
    off += c.byteLength;
  }
  return new TextDecoder().decode(buf);
}

function clientKey(req: Request): string {
  // Cloudflare sets CF-Connecting-IP; self-hosters behind a proxy should set X-Real-IP.
  return req.headers.get('CF-Connecting-IP') ?? req.headers.get('X-Real-IP') ?? 'unknown';
}

const NOT_FOUND = 'Not found, expired, or already viewed';

export function createApp(deps: AppDeps): Handler {
  const now = deps.now ?? Date.now;

  async function limited(bucket: RateBucket, req: Request): Promise<Response | undefined> {
    if (await deps.rateLimiter.allow(bucket, clientKey(req))) return undefined;
    return apiError(429, 'Too many requests, slow down', { 'Retry-After': '60' });
  }

  async function createSecret(req: Request): Promise<Response> {
    const ct = req.headers.get('Content-Type') ?? '';
    // Requiring JSON forces a CORS preflight for cross-origin callers, which we never approve.
    if (!/^application\/json\b/i.test(ct))
      return apiError(415, 'Content-Type must be application/json');
    let text: string;
    try {
      text = await readBodyLimited(req, MAX_BODY_BYTES);
    } catch (e) {
      if (e instanceof BodyTooLarge) return apiError(413, `Body exceeds ${MAX_BODY_BYTES} bytes`);
      throw e;
    }
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      return apiError(400, 'Invalid JSON');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body))
      return apiError(400, 'Invalid body');
    const b = body as Record<string, unknown>;
    if (Object.keys(b).some((k) => !['envelope', 'ttlSeconds', 'maxViews'].includes(k))) {
      return apiError(400, 'Unknown fields in body');
    }
    if (!validateEnvelope(b.envelope)) return apiError(400, 'Invalid envelope');
    if (typeof b.ttlSeconds !== 'number' || !ALLOWED_TTL_SECONDS.includes(b.ttlSeconds)) {
      return apiError(400, `ttlSeconds must be one of ${ALLOWED_TTL_SECONDS.join(', ')}`);
    }
    if (
      typeof b.maxViews !== 'number' ||
      !Number.isInteger(b.maxViews) ||
      b.maxViews < MIN_VIEWS ||
      b.maxViews > MAX_VIEWS
    ) {
      return apiError(400, `maxViews must be an integer between ${MIN_VIEWS} and ${MAX_VIEWS}`);
    }

    const revokeToken = toBase64Url(randomBytes(REVOKE_TOKEN_BYTES));
    const expiresAt = now() + b.ttlSeconds * 1000;
    const record = {
      envelope: b.envelope,
      viewsLeft: b.maxViews,
      expiresAt,
      revokeHash: await sha256B64Url(revokeToken),
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const id = toBase64Url(randomBytes(ID_BYTES));
      if (await deps.store.create(id, record)) {
        const res: CreateSecretResponse = { id, revokeToken, expiresAt };
        return json(res, 201);
      }
    }
    return apiError(500, 'Could not allocate id');
  }

  async function getSecret(id: string): Promise<Response> {
    const r = await deps.store.take(id, now());
    if (!r) return apiError(404, NOT_FOUND);
    const res: GetSecretResponse = {
      envelope: r.envelope,
      viewsLeft: r.viewsLeft,
      expiresAt: r.expiresAt,
    };
    return json(res);
  }

  async function revokeSecret(req: Request, id: string): Promise<Response> {
    const m = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(req.headers.get('Authorization') ?? '');
    if (!m) return apiError(401, 'Missing or malformed revoke token');
    const ok = await deps.store.revoke(id, await sha256B64Url(m[1]!), now());
    return ok ? new Response(null, { status: 204 }) : apiError(404, NOT_FOUND);
  }

  async function route(req: Request): Promise<{ res: Response; csp?: string }> {
    const url = new URL(req.url);
    const path = url.pathname;
    const method = req.method.toUpperCase();

    if (path === '/health' && method === 'GET') return { res: json({ ok: true }) };

    if (path === '/api/secrets') {
      if (method !== 'POST') return { res: apiError(405, 'Method not allowed', { Allow: 'POST' }) };
      return { res: (await limited('create', req)) ?? (await createSecret(req)) };
    }

    const api = /^\/api\/secrets\/([^/]+)$/.exec(path);
    if (api) {
      const id = api[1]!;
      if (method === 'GET') {
        const lim = await limited('read', req);
        if (lim) return { res: lim };
        return { res: isValidId(id) ? await getSecret(id) : apiError(404, NOT_FOUND) };
      }
      if (method === 'DELETE') {
        const lim = await limited('revoke', req);
        if (lim) return { res: lim };
        return { res: isValidId(id) ? await revokeSecret(req, id) : apiError(404, NOT_FOUND) };
      }
      return { res: apiError(405, 'Method not allowed', { Allow: 'GET, DELETE' }) };
    }

    if (deps.assets && method === 'GET') {
      const a = deps.assets;
      const asset = (body: string, type: string, csp?: string) => ({
        res: new Response(body, { headers: { 'Content-Type': type } }),
        csp,
      });
      if (/^\/s\/[A-Za-z0-9_-]{22}\/?$/.test(path)) {
        // Static page; it never fetches the blob until the user clicks "Decrypt",
        // so chat link previews cannot burn a view.
        return asset(a.html, 'text/html; charset=utf-8', PAGE_CSP);
      }
      if (path === '/' && a.landing) return asset(a.landing, 'text/html; charset=utf-8', PAGE_CSP);
      if (path === '/assets/client.js') return asset(a.js, 'text/javascript; charset=utf-8');
      if (path === '/assets/style.css') return asset(a.css, 'text/css; charset=utf-8');
      if ((path === '/assets/logo.svg' || path === '/favicon.ico') && a.logo) {
        return asset(a.logo, 'image/svg+xml');
      }
    }
    return { res: apiError(404, 'Not found') };
  }

  return async (req) => {
    try {
      const { res, csp } = await route(req);
      return withSecurityHeaders(res, csp);
    } catch (e) {
      if (e instanceof StoreFullError)
        return withSecurityHeaders(
          apiError(503, 'Server is at capacity, try again later', { 'Retry-After': '60' }),
        );
      // Never log request bodies or ids; the error class is enough to debug.
      console.error('envdrop: internal error', e instanceof Error ? e.name : typeof e);
      return withSecurityHeaders(apiError(500, 'Internal error'));
    }
  };
}
