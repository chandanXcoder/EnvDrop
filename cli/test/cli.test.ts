import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { startNodeServer } from '../../server/src/node';
import {
  checkCmd,
  type Ctx,
  exampleCmd,
  hookCmd,
  pullCmd,
  revokeCmd,
  scanCmd,
  shareCmd,
} from '../src/commands';
import { LinkStore } from '../src/linkStore';
import { palette, type Io } from '../src/ui';

let server: Server;
let serverUrl: string;
let dir: string;
let out: string[];
let hidden: string[];

beforeAll(async () => {
  server = await startNodeServer({ port: 0, host: '127.0.0.1' });
  serverUrl = `http://localhost:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((r) => server.close(() => r())));

function ctx(cwd = dir): Ctx {
  const io: Io = {
    out: (s) => out.push(s),
    err: (s) => out.push(s),
    isTTY: false,
    color: false,
    ask: async () => '',
    askHidden: async () => hidden.shift() ?? '',
  };
  return {
    io,
    c: palette(false),
    cwd,
    store: new LinkStore(path.join(dir, '.cfg')),
    serverUrl,
    fastKdf: true,
  };
}
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
const linkFrom = (lines: string[]) => lines.join('\n').match(/http:\/\/localhost:\d+\/s\/\S+/)![0];
const j = (...p: string[]) => p.join('');

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'envdrop-cli-'));
  out = [];
  hidden = [];
});

describe('envdrop share / pull', () => {
  it('round-trips into a new file and burns the link', async () => {
    writeFileSync(path.join(dir, '.env'), 'A=1\nSECRET="s3cr3t value"\n');
    expect(await shareCmd(ctx(), { expiry: '10m', views: '1' })).toBe(0);
    const link = linkFrom(out);
    expect(out.join('\n')).not.toContain('s3cr3t');

    const dest = mkdtempSync(path.join(tmpdir(), 'envdrop-dst-'));
    try {
      hidden.push(link);
      out = [];
      expect(await pullCmd(ctx(dest), { yes: true })).toBe(0);
      expect(readFileSync(path.join(dest, '.env'), 'utf8')).toBe('A=1\nSECRET="s3cr3t value"\n');
      expect(out.join('\n')).not.toContain('s3cr3t'); // masked listing
      hidden.push(link);
      await expect(pullCmd(ctx(dest), { yes: true })).rejects.toThrow(/expired|already viewed/);
    } finally {
      rmSync(dest, { recursive: true, force: true });
    }
  });

  it('merges into an existing file with a backup, and supports passphrases', async () => {
    writeFileSync(path.join(dir, '.env.staging'), 'A=2\nNEW=yes\n');
    hidden.push('correct horse battery');
    expect(await shareCmd(ctx(), { file: '.env.staging', passphrase: true, views: '2' })).toBe(0);
    const link = linkFrom(out);
    writeFileSync(path.join(dir, '.env.staging'), 'A=1\nLOCAL=keep\n');
    hidden.push(link, 'wrong-pass', 'correct horse battery');
    expect(await pullCmd(ctx(), { merge: true })).toBe(0);
    expect(readFileSync(path.join(dir, '.env.staging'), 'utf8')).toBe(
      'A=2\nLOCAL=keep\n\nNEW=yes\n',
    );
    expect(readFileSync(path.join(dir, '.env.staging.backup'), 'utf8')).toBe('A=1\nLOCAL=keep\n');
    expect(out.join('\n')).toMatch(/~ A\s+changed/);
  });

  it('refuses to share a non-gitignored file in a repo without --force (non-interactive)', async () => {
    git('init', '-q');
    writeFileSync(path.join(dir, '.env'), 'A=1\n');
    await expect(shareCmd(ctx(), {})).rejects.toThrow(/--force/);
    expect(await shareCmd(ctx(), { force: true })).toBe(0);
  });

  it('lists and revokes links', async () => {
    writeFileSync(path.join(dir, '.env'), 'A=1\n');
    await shareCmd(ctx(), { views: '3' });
    const [rec] = await new LinkStore(path.join(dir, '.cfg')).list();
    out = [];
    expect(await revokeCmd(ctx(), {})).toBe(0);
    expect(out.join('\n')).toContain(rec!.id);
    expect(await revokeCmd(ctx(), { id: rec!.id })).toBe(0);
    expect(out.join('\n')).toMatch(/revoked/);
    expect(await new LinkStore(path.join(dir, '.cfg')).list()).toEqual([]);
  });
});

describe('envdrop scan / hook', () => {
  it('blocks staged env files and tokens, passes clean changes', async () => {
    git('init', '-q');
    writeFileSync(path.join(dir, 'ok.ts'), 'export const x = 1;\n');
    git('add', 'ok.ts');
    expect(await scanCmd(ctx(), { staged: true, files: [] })).toBe(0);

    writeFileSync(path.join(dir, '.env'), 'A=1\n');
    writeFileSync(
      path.join(dir, 'cfg.ts'),
      `const t = "${j('ghp_', 'a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8')}";\n`,
    );
    git('add', '.env', 'cfg.ts');
    out = [];
    expect(await scanCmd(ctx(), { staged: true, files: [] })).toBe(1);
    const text = out.join('\n');
    expect(text).toContain('.env');
    expect(text).toContain('GitHub token');
    expect(text).not.toContain('a1B2c3D4e5F6');
  });

  it('installs the hook without clobbering an existing one, and uninstalls cleanly', async () => {
    git('init', '-q');
    const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
    writeFileSync(hook, '#!/bin/sh\necho existing\n');
    chmodSync(hook, 0o755);
    await hookCmd(ctx(), 'install');
    await hookCmd(ctx(), 'install');
    const text = readFileSync(hook, 'utf8');
    expect(text).toContain('echo existing');
    expect(text.match(/>>> envdrop pre-commit >>>/g)).toHaveLength(1);
    await hookCmd(ctx(), 'uninstall');
    expect(readFileSync(hook, 'utf8')).not.toContain('envdrop');
    expect(readFileSync(hook, 'utf8')).toContain('echo existing');
  });

  it('creates a fresh hook file when none exists', async () => {
    git('init', '-q');
    await hookCmd(ctx(), 'install');
    const hook = path.join(dir, '.git', 'hooks', 'pre-commit');
    expect(readFileSync(hook, 'utf8').startsWith('#!/bin/sh')).toBe(true);
    await hookCmd(ctx(), 'uninstall');
    expect(existsSync(hook)).toBe(false);
  });
});

describe('envdrop example / check', () => {
  it('generates an example and reports missing keys', async () => {
    writeFileSync(path.join(dir, '.env'), 'A=secret\nB=2\n');
    expect(await exampleCmd(ctx(), {})).toBe(0);
    expect(readFileSync(path.join(dir, '.env.example'), 'utf8')).toBe('A=\nB=\n');
    expect(await checkCmd(ctx(), {})).toBe(0);
    writeFileSync(path.join(dir, '.env.example'), 'A=\nB=\nC=\n');
    out = [];
    expect(await checkCmd(ctx(), {})).toBe(1);
    expect(out.join('\n')).toMatch(/missing\s+C/);
  });
});
