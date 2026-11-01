import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { defaultGitRunner, type GitRunner } from '@envdrop/core';

const START = '# >>> envdrop pre-commit >>>';
const END = '# <<< envdrop pre-commit <<<';
const BLOCK = `${START}
# Blocks commits that stage .env files or obvious secrets. Bypass once: git commit --no-verify
if command -v envdrop >/dev/null 2>&1; then
  envdrop scan --staged || exit 1
else
  npx --yes envdrop@latest scan --staged || exit 1
fi
${END}`;

async function hooksDir(cwd: string, git: GitRunner): Promise<string> {
  const r = await git(['rev-parse', '--git-path', 'hooks'], cwd);
  if (r.code !== 0) throw new Error('Not inside a git repository.');
  return path.resolve(cwd, r.stdout.trim());
}

/** Installs (or refreshes) an envdrop block in .git/hooks/pre-commit without clobbering other hooks. */
export async function installHook(
  cwd: string,
  git: GitRunner = defaultGitRunner,
): Promise<{ file: string; created: boolean }> {
  const dir = await hooksDir(cwd, git);
  const file = path.join(dir, 'pre-commit');
  let existing = '';
  try {
    existing = await fs.readFile(file, 'utf8');
  } catch {
    /* new file */
  }
  let next: string;
  if (existing.includes(START)) {
    next = existing.replace(new RegExp(`${START}[\\s\\S]*?${END}`), BLOCK);
  } else if (existing.trim()) {
    next = `${existing.replace(/\s*$/, '')}\n\n${BLOCK}\n`;
  } else {
    next = `#!/bin/sh\n${BLOCK}\n`;
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(file, next, { mode: 0o755 });
  await fs.chmod(file, 0o755);
  return { file, created: existing === '' };
}

export async function uninstallHook(
  cwd: string,
  git: GitRunner = defaultGitRunner,
): Promise<boolean> {
  const file = path.join(await hooksDir(cwd, git), 'pre-commit');
  let existing: string;
  try {
    existing = await fs.readFile(file, 'utf8');
  } catch {
    return false;
  }
  if (!existing.includes(START)) return false;
  const next = existing.replace(new RegExp(`\\n*${START}[\\s\\S]*?${END}\\n?`), '\n');
  if (next.trim() === '#!/bin/sh' || next.trim() === '') await fs.unlink(file);
  else await fs.writeFile(file, next);
  return true;
}
