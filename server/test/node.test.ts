import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { encryptPayload, MAX_BODY_BYTES } from '@envdrop/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startNodeServer } from '../src/node';

let server: Server;
let base: string;

beforeAll(async () => {
  server = await startNodeServer({
    port: 0,
    host: '127.0.0.1',
    maxEntries: 3,
    assets: { html: '<p>decrypt</p>', landing: '<p>landing</p>', js: '', css: '' },
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

const post = async (maxViews = 1) => {
  const { envelope } = await encryptPayload({ name: '.env', content: 'A=1' });
  return fetch(`${base}/api/secrets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ envelope, ttlSeconds: 600, maxViews }),
  });
};

describe('self-hosted Node server', () => {
  it('serves the API end to end with security headers', async () => {
    const res = await post(1);
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };
    const g = await fetch(`${base}/api/secrets/${id}`);
    expect(g.status).toBe(200);
    expect(g.headers.get('x-content-type-options')).toBe('nosniff');
    expect((await fetch(`${base}/api/secrets/${id}`)).status).toBe(404);
    expect(await (await fetch(`${base}/`)).text()).toContain('landing');
  });

  it('streams and rejects oversized bodies', async () => {
    const res = await fetch(`${base}/api/secrets`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: 'x'.repeat(MAX_BODY_BYTES + 10),
    });
    expect(res.status).toBe(413);
  });

  it('returns 503 when the in-memory store is full', async () => {
    const codes: number[] = [];
    for (let i = 0; i < 4; i++) codes.push((await post(5)).status);
    expect(codes).toContain(503);
  });

  it('ignores client-supplied IP headers for rate limiting', async () => {
    // 60 reads/minute per IP; spoofed headers must not grant fresh buckets.
    const statuses: number[] = [];
    for (let i = 0; i < 65; i++) {
      const r = await fetch(`${base}/api/secrets/AAAAAAAAAAAAAAAAAAAAAA`, {
        headers: { 'X-Real-IP': `10.0.0.${i}`, 'CF-Connecting-IP': `10.1.0.${i}` },
      });
      statuses.push(r.status);
    }
    expect(statuses).toContain(429);
  });
});
