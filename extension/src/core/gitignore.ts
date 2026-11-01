/**
 * "Is this file protected from being committed?"
 *
 * Preferred: ask git itself (`git check-ignore`, `git ls-files`), which handles every
 * edge case (nested .gitignore files, core.excludesFile, .git/info/exclude).
 * Fallback when git is missing: evaluate the chain of .gitignore files with the
 * `ignore` package.
 */
import { execFile } from 'node:child_process';
import { existsSync, promises as fs } from 'node:fs';
import * as path from 'node:path';
import ignore from 'ignore';

export type IgnoreStatus =
  | 'ignored' // safe: git will not pick it up
  | 'not-ignored' // dangerous: `git add .` would stage it
  | 'tracked' // worst: already committed/staged; ignoring won't help until untracked
  | 'no-repo'; // not inside a git repository

export interface IgnoreCheck {
  status: IgnoreStatus;
  method: 'git' | 'fallback';
  repoRoot?: string;
}

export type GitRunner = (args: string[], cwd: string) => Promise<{ code: number; stdout: string }>;

export const defaultGitRunner: GitRunner = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile('git', args, { cwd, timeout: 10_000, windowsHide: true }, (err, stdout) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') return reject(err);
      const code = err ? (typeof err.code === 'number' ? err.code : 1) : 0;
      resolve({ code, stdout: String(stdout) });
    });
  });

export function findRepoRoot(startDir: string, stopAt?: string): string | undefined {
  let dir = path.resolve(startDir);
  for (;;) {
    if (existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir || (stopAt && dir === path.resolve(stopAt))) return undefined;
    dir = parent;
  }
}

async function checkWithGit(file: string, git: GitRunner): Promise<IgnoreCheck> {
  const cwd = path.dirname(file);
  const top = await git(['rev-parse', '--show-toplevel'], cwd);
  if (top.code !== 0) return { status: 'no-repo', method: 'git' };
  const repoRoot = top.stdout.trim();
  const tracked = await git(['ls-files', '--error-unmatch', '--', file], cwd);
  if (tracked.code === 0) return { status: 'tracked', method: 'git', repoRoot };
  const ign = await git(['check-ignore', '-q', '--', file], cwd);
  if (ign.code === 0) return { status: 'ignored', method: 'git', repoRoot };
  if (ign.code === 1) return { status: 'not-ignored', method: 'git', repoRoot };
  throw new Error('git check-ignore failed');
}

async function readIfExists(p: string): Promise<string | undefined> {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return undefined;
  }
}

/** Pure-JS evaluation of nested .gitignore files from repoRoot down to the file. */
export async function checkWithFallback(file: string, repoRoot: string): Promise<boolean> {
  const abs = path.resolve(file);
  const relFromRoot = path.relative(repoRoot, abs).split(path.sep);
  // Candidate paths to test: each ancestor directory (with trailing slash) and the file.
  const targets = relFromRoot.map((_, i) => {
    const p = relFromRoot.slice(0, i + 1).join('/');
    return i < relFromRoot.length - 1 ? `${p}/` : p;
  });

  for (const target of targets) {
    // git: if a parent directory is excluded, nothing inside can be re-included.
    let state: boolean | undefined;
    const targetDepth = target.replace(/\/$/, '').split('/').length;
    for (let depth = 0; depth < targetDepth; depth++) {
      const dir = path.join(repoRoot, ...relFromRoot.slice(0, depth));
      const content = await readIfExists(path.join(dir, '.gitignore'));
      if (content === undefined) continue;
      const rel = target.split('/').slice(depth).join('/');
      const r = ignore().add(content).test(rel);
      if (r.ignored) state = true;
      else if (r.unignored) state = false;
    }
    if (state === true) return true;
  }
  return false;
}

export async function checkIgnored(
  file: string,
  opts: { git?: GitRunner; workspaceRoot?: string } = {},
): Promise<IgnoreCheck> {
  try {
    return await checkWithGit(file, opts.git ?? defaultGitRunner);
  } catch {
    const repoRoot = findRepoRoot(path.dirname(file));
    if (!repoRoot) return { status: 'no-repo', method: 'fallback' };
    const ignored = await checkWithFallback(file, repoRoot);
    return { status: ignored ? 'ignored' : 'not-ignored', method: 'fallback', repoRoot };
  }
}

/**
 * Appends `entry` to `<dir>/.gitignore` if no identical line exists. Creates the file if
 * missing and makes sure we don't glue onto a last line without a newline.
 * Returns true if the file changed.
 */
export async function addToGitignore(dir: string, entries: string[]): Promise<boolean> {
  const file = path.join(dir, '.gitignore');
  const existing = (await readIfExists(file)) ?? '';
  const eol = existing.includes('\r\n') ? '\r\n' : '\n';
  const lines = new Set(existing.split(/\r?\n/).map((l) => l.trim()));
  const missing = entries.filter((e) => !lines.has(e) && !lines.has(`/${e}`));
  if (missing.length === 0) return false;
  let out = existing;
  if (out.length > 0 && !out.endsWith('\n')) out += eol;
  if (out.length > 0) out += eol;
  out += `# Added by EnvDrop: keep secrets out of git${eol}${missing.join(eol)}${eol}`;
  await fs.writeFile(file, out, 'utf8');
  return true;
}

/** Recommended .gitignore entries for an env file (relative to the .gitignore's dir). */
export function gitignoreEntriesFor(file: string, gitignoreDir: string): string[] {
  const rel = path.relative(gitignoreDir, file).split(path.sep).join('/');
  // Root-level files get the bare basename (matches at any depth, the common convention).
  const entry = rel.includes('/') ? `/${rel}` : path.basename(file);
  return [entry, `${entry}.backup`];
}

/** `git rm --cached` so a tracked env file stops being tracked (keeps the local copy). */
export async function untrack(file: string, git: GitRunner = defaultGitRunner): Promise<boolean> {
  const r = await git(['rm', '--cached', '--quiet', '--', file], path.dirname(file));
  return r.code === 0;
}
