import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  addToGitignore,
  checkIgnored,
  checkWithFallback,
  type GitRunner,
  gitignoreEntriesFor,
} from '../src/gitignore';

let dir: string;
const w = (rel: string, content = '') => {
  const p = path.join(dir, rel);
  mkdirSync(path.dirname(p), { recursive: true });
  writeFileSync(p, content);
  return p;
};
const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
const noGit: GitRunner = async () => {
  throw Object.assign(new Error('spawn git ENOENT'), { code: 'ENOENT' });
};

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'envdrop-gi-'));
  git('init', '-q');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const cases: [string, Record<string, string>, string, boolean][] = [
  ['no .gitignore', {}, '.env', false],
  ['exact', { '.gitignore': '.env\n' }, '.env', true],
  ['glob .env*', { '.gitignore': '.env*\n' }, '.env.production', true],
  ['glob does not cover other file', { '.gitignore': '.env\n' }, '.env.local', false],
  ['nested file matched by root basename', { '.gitignore': '.env\n' }, 'apps/web/.env', true],
  ['nested .gitignore', { 'apps/.gitignore': '.env\n' }, 'apps/web/.env', true],
  ['negation re-includes', { '.gitignore': '.env*\n!.env.production\n' }, '.env.production', false],
  [
    'nested negation overrides root',
    { '.gitignore': '.env\n', 'apps/.gitignore': '!.env\n' },
    'apps/.env',
    false,
  ],
  ['ignored parent dir', { '.gitignore': 'secrets/\n' }, 'secrets/.env', true],
  ['anchored path', { '.gitignore': '/config/.env\n' }, 'config/.env', true],
  ['comment line is not a rule', { '.gitignore': '# .env\n' }, '.env', false],
];

describe('checkIgnored (git and fallback agree)', () => {
  it.each(cases)('%s', async (_name, files, target, expected) => {
    for (const [p, c] of Object.entries(files)) w(p, c);
    const file = w(target, 'A=1\n');
    const viaGit = await checkIgnored(file);
    expect(viaGit.method).toBe('git');
    expect(viaGit.status).toBe(expected ? 'ignored' : 'not-ignored');
    const viaFallback = await checkIgnored(file, { git: noGit });
    expect(viaFallback.method).toBe('fallback');
    expect(viaFallback.status).toBe(expected ? 'ignored' : 'not-ignored');
    expect(await checkWithFallback(file, dir)).toBe(expected);
  });

  it('reports tracked files even if they are also ignored', async () => {
    const file = w('.env', 'A=1\n');
    git('add', '.env');
    w('.gitignore', '.env\n');
    expect((await checkIgnored(file)).status).toBe('tracked');
  });

  it('reports no-repo outside git', async () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'envdrop-nogit-'));
    try {
      const f = path.join(outside, '.env');
      writeFileSync(f, 'A=1');
      expect((await checkIgnored(f)).status).toBe('no-repo');
      expect((await checkIgnored(f, { git: noGit })).status).toBe('no-repo');
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe('addToGitignore', () => {
  it('creates .gitignore when missing and is idempotent', async () => {
    expect(await addToGitignore(dir, ['.env', '.env.backup'])).toBe(true);
    expect(await addToGitignore(dir, ['.env', '.env.backup'])).toBe(false);
    const text = readFileSync(path.join(dir, '.gitignore'), 'utf8');
    expect(text.match(/^\.env$/gm)).toHaveLength(1);
    expect((await checkIgnored(w('.env'))).status).toBe('ignored');
  });

  it('does not glue onto a last line without newline', async () => {
    w('.gitignore', 'node_modules');
    await addToGitignore(dir, ['.env']);
    const lines = readFileSync(path.join(dir, '.gitignore'), 'utf8').split('\n');
    expect(lines).toContain('node_modules');
    expect(lines).toContain('.env');
  });

  it('builds entries for nested files', () => {
    expect(gitignoreEntriesFor(path.join(dir, '.env'), dir)).toEqual(['.env', '.env.backup']);
    expect(gitignoreEntriesFor(path.join(dir, 'apps/web/.env'), dir)).toEqual([
      '/apps/web/.env',
      '/apps/web/.env.backup',
    ]);
  });
});
