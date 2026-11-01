import {
  encryptPayload,
  MAX_BODY_BYTES,
  type CreateSecretResponse,
  type Envelope,
} from '@envdrop/shared';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp, type Handler } from '../src/app';
import { MemoryStore } from '../src/memoryStore';
import { DEFAULT_LIMITS, MemoryRateLimiter } from '../src/rateLimit';

const BASE = 'https://envdrop.test';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const body = (res: Response): Promise<any> => res.json();
let envelope: Envelope;
let store: MemoryStore;
let clock: number;
let app: Handler;

function post(body: unknown, headers: Record<string, string> = {}) {
  return app(
    new Request(`${BASE}/api/secrets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
  );
}
const get = (id: string, ip = '1.1.1.1') =>
  app(new Request(`${BASE}/api/secrets/${id}`, { headers: { 'CF-Connecting-IP': ip } }));
const del = (id: string, token?: string) =>
  app(
    new Request(`${BASE}/api/secrets/${id}`, {
      method: 'DELETE',
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    }),
  );

async function create(maxViews = 1, ttlSeconds = 600): Promise<CreateSecretResponse> {
  const res = await post({ envelope, ttlSeconds, maxViews });
  expect(res.status).toBe(201);
  return body(res);
}

beforeEach(async () => {
  envelope ??= (await encryptPayload({ name: '.env', content: 'A=1' })).envelope;
  store = new MemoryStore();
  clock = 1_000_000;
  app = createApp({ store, rateLimiter: new MemoryRateLimiter(), now: () => clock });
});

describe('POST /api/secrets', () => {
  it('stores and returns id, revoke token and expiry', async () => {
    const r = await create(1, 3600);
    expect(r.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(r.revokeToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(r.expiresAt).toBe(clock + 3600_000);
    expect(store.size).toBe(1);
  });

  it.each([
    [{ envelope: { v: 1 }, ttlSeconds: 600, maxViews: 1 }, 'envelope'],
    [{ ttlSeconds: 600, maxViews: 1 }, 'envelope'],
    [{ ttlSeconds: 601, maxViews: 1, ok: true }, 'ttlSeconds'],
    [{ ttlSeconds: 600, maxViews: 0, ok: true }, 'maxViews'],
    [{ ttlSeconds: 600, maxViews: 11, ok: true }, 'maxViews'],
    [{ ttlSeconds: 600, maxViews: 1.5, ok: true }, 'maxViews'],
    [{ ttlSeconds: 600, maxViews: 1, ok: true, name: '.env' }, 'Unknown'],
  ])('rejects invalid body %#', async (row, msg) => {
    const { ok, ...rest } = row as Record<string, unknown>;
    const res = await post(ok ? { envelope, ...rest } : rest);
    expect(res.status).toBe(400);
    expect((await body(res)).error).toContain(msg);
  });

  it('rejects non-JSON content types and bad JSON', async () => {
    expect((await post('{}', { 'Content-Type': 'text/plain' })).status).toBe(415);
    expect((await post('{not json')).status).toBe(400);
  });

  it('rejects bodies over 64 KB', async () => {
    const big = JSON.stringify({
      envelope: { ...envelope, ct: 'A'.repeat(MAX_BODY_BYTES) },
      ttlSeconds: 600,
      maxViews: 1,
    });
    expect((await post(big)).status).toBe(413);
  });
});

describe('GET /api/secrets/:id', () => {
  it('burns after the last view', async () => {
    const { id } = await create(2);
    const r1 = await get(id);
    expect(r1.status).toBe(200);
    expect(r1.headers.get('Cache-Control')).toBe('no-store');
    const b1 = await body(r1);
    expect(b1.envelope).toEqual(envelope);
    expect(b1.viewsLeft).toBe(1);
    expect((await body(await get(id))).viewsLeft).toBe(0);
    expect(store.has(id)).toBe(false);
    expect((await get(id)).status).toBe(404);
  });

  it('is atomic for concurrent reads of a 1-view secret', async () => {
    const { id } = await create(1);
    const results = await Promise.all(Array.from({ length: 10 }, () => get(id)));
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
  });

  it('expires after TTL', async () => {
    const { id } = await create(5, 600);
    clock += 600_000;
    expect((await get(id)).status).toBe(404);
    expect(store.has(id)).toBe(false);
  });

  it('returns the same 404 for unknown, malformed and burned ids', async () => {
    const a = await get('AAAAAAAAAAAAAAAAAAAAAA');
    const b = await get('short%2F..');
    expect(a.status).toBe(404);
    expect(b.status).toBe(404);
    expect(await body(a)).toEqual(await body(b));
  });
});

describe('DELETE /api/secrets/:id', () => {
  it('revokes with the right token only', async () => {
    const { id, revokeToken } = await create(3);
    expect((await del(id)).status).toBe(401);
    expect((await del(id, 'x'.repeat(43))).status).toBe(404);
    expect(store.has(id)).toBe(true);
    expect((await del(id, revokeToken)).status).toBe(204);
    expect((await get(id)).status).toBe(404);
    expect((await del(id, revokeToken)).status).toBe(404);
  });
});

describe('cross-cutting', () => {
  it('rate limits per IP', async () => {
    const { id } = await create(1);
    const limit = DEFAULT_LIMITS.read.limit;
    for (let i = 0; i < limit; i++) await get(id, '9.9.9.9');
    expect((await get(id, '9.9.9.9')).status).toBe(429);
    expect((await get(id, '8.8.8.8')).status).toBe(404);
  });

  it('sets security headers and no CORS headers', async () => {
    const res = await app(
      new Request(`${BASE}/health`, { headers: { Origin: 'https://evil.example' } }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.get('Content-Security-Policy')).toContain("default-src 'none'");
    expect(res.headers.get('Strict-Transport-Security')).toBeTruthy();
  });

  it('rejects wrong methods', async () => {
    expect((await app(new Request(`${BASE}/api/secrets`))).status).toBe(405);
    expect((await app(new Request(`${BASE}/api/secrets`, { method: 'OPTIONS' }))).status).toBe(405);
  });

  it('serves the web page only when assets are configured, without touching the store', async () => {
    const { id } = await create(1);
    expect((await app(new Request(`${BASE}/s/${id}`))).status).toBe(404);
    const withWeb = createApp({
      store,
      rateLimiter: new MemoryRateLimiter(),
      assets: { html: '<html></html>', js: '', css: '' },
    });
    const page = await withWeb(new Request(`${BASE}/s/${id}`));
    expect(page.status).toBe(200);
    expect(page.headers.get('Content-Security-Policy')).toContain("script-src 'self'");
    expect(store.has(id)).toBe(true); // preview bots fetching /s/:id don't burn views
  });
});
