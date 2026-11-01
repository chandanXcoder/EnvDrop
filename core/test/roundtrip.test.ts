/**
 * Integration: share -> pull round trip through the real API handler and an in-memory
 * store, using the same client code the extension uses.
 */
import { diffEnv, mergeEnv, parseEnv } from '@envdrop/shared';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createApp } from '../../server/src/app';
import { MemoryStore } from '../../server/src/memoryStore';
import { MemoryRateLimiter } from '../../server/src/rateLimit';
import { ApiClient, type FetchLike } from '../src/apiClient';
import { backupFile } from '../src/envFiles';
import { decryptShare, fetchShare, share } from '../src/shareService';

const SERVER = 'https://envdrop.test';
let store: MemoryStore;
let fetchImpl: FetchLike;
const seen: string[] = [];

beforeEach(() => {
  store = new MemoryStore();
  const app = createApp({ store, rateLimiter: new MemoryRateLimiter() });
  seen.length = 0;
  fetchImpl = async (input, init) => {
    const req = new Request(input, init);
    seen.push(req.url + ' ' + (init?.body ?? ''));
    return app(req);
  };
});

const ENV =
  '# db\nDATABASE_URL="postgres://u:p@h/db"\nexport API_KEY=sk_test_123\nPEM="-----BEGIN-----\nabc\n-----END-----"\n';

describe('share -> pull round trip', () => {
  it('shares and pulls; server never sees key or plaintext; burns after read', async () => {
    const shared = await share({
      serverUrl: SERVER,
      name: '.env',
      content: ENV,
      ttlSeconds: 600,
      maxViews: 1,
      fetchImpl,
    });
    expect(shared.link).toMatch(
      /^https:\/\/envdrop\.test\/s\/[A-Za-z0-9_-]{22}#[A-Za-z0-9_-]{43}$/,
    );
    const key = shared.link.split('#')[1]!;

    const fetched = await fetchShare(shared.link, fetchImpl);
    const payload = await decryptShare(fetched);
    expect(payload).toEqual({ name: '.env', content: ENV });

    // Zero-knowledge: nothing sent to the server contains the key, a value, or the filename.
    const wire = seen.join('\n');
    for (const needle of [key, 'postgres://', 'sk_test_123', 'DATABASE_URL', '.env']) {
      expect(wire).not.toContain(needle);
    }
    await expect(fetchShare(shared.link, fetchImpl)).rejects.toThrow(/expired|already viewed/);
  });

  it('passphrase-protected share needs the passphrase', async () => {
    const shared = await share({
      serverUrl: SERVER,
      name: '.env.staging',
      content: ENV,
      ttlSeconds: 3600,
      maxViews: 2,
      passphrase: 'hunter2 but longer',
      fetchImpl,
      scrypt: { N: 2 ** 14, r: 8, p: 1 },
    });
    const fetched = await fetchShare(shared.link, fetchImpl);
    expect(fetched.viewsLeft).toBe(1);
    await expect(decryptShare(fetched)).rejects.toThrow(/passphrase/);
    await expect(decryptShare(fetched, 'nope')).rejects.toThrow();
    expect((await decryptShare(fetched, 'hunter2 but longer')).name).toBe('.env.staging');
  });

  it('revoke deletes the secret', async () => {
    const shared = await share({
      serverUrl: SERVER,
      name: '.env',
      content: ENV,
      ttlSeconds: 600,
      maxViews: 5,
      fetchImpl,
    });
    const client = new ApiClient(SERVER, fetchImpl);
    expect(await client.revoke(shared.id, shared.revokeToken)).toBe(true);
    expect(await client.revoke(shared.id, shared.revokeToken)).toBe(false);
    await expect(fetchShare(shared.link, fetchImpl)).rejects.toThrow();
  });

  it('pull into an existing file: diff, backup and merge', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'envdrop-rt-'));
    try {
      const local = path.join(dir, '.env');
      writeFileSync(local, 'DATABASE_URL=old\nLOCAL_ONLY=1\n');
      const shared = await share({
        serverUrl: SERVER,
        name: '.env',
        content: ENV,
        ttlSeconds: 600,
        maxViews: 1,
        fetchImpl,
      });
      const payload = await decryptShare(await fetchShare(shared.link, fetchImpl));

      const localText = readFileSync(local, 'utf8');
      const d = diffEnv(parseEnv(localText), parseEnv(payload.content));
      expect(d).toEqual({
        added: ['API_KEY', 'PEM'],
        removed: ['LOCAL_ONLY'],
        changed: ['DATABASE_URL'],
        unchanged: [],
      });

      const backup = await backupFile(local);
      writeFileSync(
        local,
        mergeEnv(localText, payload.content, { apply: ['DATABASE_URL', 'PEM'] }),
      );
      expect(readFileSync(backup, 'utf8')).toBe(localText);
      const merged = parseEnv(readFileSync(local, 'utf8')).entries;
      expect(merged.get('DATABASE_URL')!.value).toBe('postgres://u:p@h/db');
      expect(merged.get('PEM')!.value).toBe('-----BEGIN-----\nabc\n-----END-----');
      expect(merged.has('LOCAL_ONLY')).toBe(true);
      expect(merged.has('API_KEY')).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects insecure server URLs and incomplete links', async () => {
    expect(() => new ApiClient('http://evil.example')).toThrow(/https/);
    expect(new ApiClient('http://localhost:8787/x').origin).toBe('http://localhost:8787');
    await expect(
      fetchShare('https://envdrop.test/s/AAAAAAAAAAAAAAAAAAAAAA', fetchImpl),
    ).rejects.toThrow(/complete/);
  });
});
