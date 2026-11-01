import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  addToGitignore,
  ApiClient,
  backupFile,
  checkIgnored,
  decryptShare,
  type FetchLike,
  fetchShare,
  findEnvFiles,
  gitignoreEntriesFor,
  qrTerminal,
  safeIncomingName,
  share,
  untrack,
} from '@envdrop/core';
import {
  checkKeys,
  DecryptionError,
  diffEnv,
  EXPIRY_OPTIONS,
  type ExpiryOption,
  generateExample,
  MAX_VIEWS,
  MIN_VIEWS,
  mergeEnv,
  needsPassphrase,
  parseEnv,
  parseShareLink,
  scanText,
} from '@envdrop/shared';
import { copyToClipboard } from './clipboard';
import { installHook, uninstallHook } from './hook';
import type { LinkStore } from './linkStore';
import { scanStaged } from './staged';
import { box, choose, confirm, type Io, type Palette, spin, sym } from './ui';

export const DEFAULT_SERVER = 'https://envdrop.example.workers.dev';

export interface Ctx {
  io: Io;
  c: Palette;
  cwd: string;
  store: LinkStore;
  serverUrl: string;
  fetchImpl?: FetchLike;
  /** tests: cheaper scrypt */
  fastKdf?: boolean;
  copy?: (text: string) => Promise<boolean>;
}

export class CliError extends Error {
  constructor(
    message: string,
    readonly code = 1,
  ) {
    super(message);
  }
}

const rel = (ctx: Ctx, p: string) => path.relative(ctx.cwd, p) || p;

async function resolveEnvFile(ctx: Ctx, file?: string): Promise<string> {
  if (file) {
    const p = path.resolve(ctx.cwd, file);
    try {
      await fs.access(p);
    } catch {
      throw new CliError(`File not found: ${file}`);
    }
    return p;
  }
  const found = await findEnvFiles(ctx.cwd);
  if (found.length === 0)
    throw new CliError('No .env file here. Pass a path: envdrop share path/to/.env');
  if (found.length === 1 || !ctx.io.isTTY) return found[0]!;
  const choice = await choose(
    ctx.io,
    ctx.c,
    'Which environment?',
    found.map((f) => [f, path.basename(f)] as [string, string]),
    found[0]!,
  );
  return choice;
}

/** .gitignore guard. Returns false if the user aborted. */
async function guard(ctx: Ctx, file: string, force: boolean): Promise<boolean> {
  const { io, c } = ctx;
  const s = sym(c);
  const check = await checkIgnored(file);
  if (check.status === 'ignored') {
    io.out(`${s.git} ${c.dim(`${rel(ctx, file)} is protected by .gitignore`)}`);
    return true;
  }
  if (check.status === 'no-repo') return true;
  const dir = check.repoRoot ?? path.dirname(file);
  if (check.status === 'tracked') {
    io.out(
      `${s.err} ${c.bold(rel(ctx, file))} is ${c.red('tracked by git')}: it is (or will be) committed. Rotate anything that was pushed.`,
    );
    if (force) return true;
    if (!io.isTTY)
      throw new CliError(
        'Refusing to share a git-tracked env file non-interactively (use --force).',
      );
    if (
      await confirm(io, `${s.git} Stop tracking it (keeps your file) and add it to .gitignore?`)
    ) {
      await untrack(file);
      await addToGitignore(dir, gitignoreEntriesFor(file, dir));
      io.out(`${s.ok} Untracked and gitignored. Commit the .gitignore change.`);
      return true;
    }
    return confirm(io, 'Share anyway?', false);
  }
  io.out(
    `${s.warn} ${c.bold(rel(ctx, file))} is ${c.yellow('not covered by .gitignore')}, so it could be committed by accident.`,
  );
  if (force) return true;
  if (!io.isTTY)
    throw new CliError(
      'Refusing to share a non-gitignored env file non-interactively (use --force, or add it to .gitignore).',
    );
  if (await confirm(io, `${s.git} Add it to .gitignore now?`)) {
    await addToGitignore(dir, gitignoreEntriesFor(file, dir));
    io.out(`${s.ok} Added to ${rel(ctx, path.join(dir, '.gitignore'))}`);
    return true;
  }
  return confirm(io, 'Share anyway?', false);
}

function fmtLeft(ms: number): string {
  const m = Math.round(ms / 60_000);
  return m >= 120 ? `${Math.round(m / 60)}h` : `${Math.max(1, m)}m`;
}

export interface ShareArgs {
  file?: string;
  expiry?: string;
  views?: string;
  passphrase?: boolean;
  qr?: boolean;
  copy?: boolean;
  force?: boolean;
}

export async function shareCmd(ctx: Ctx, a: ShareArgs): Promise<number> {
  const { io, c } = ctx;
  const s = sym(c);
  const expiry = (a.expiry ?? '1h') as ExpiryOption;
  if (!(expiry in EXPIRY_OPTIONS))
    throw new CliError(`--expiry must be one of ${Object.keys(EXPIRY_OPTIONS).join(', ')}`);
  const views = Number(a.views ?? 1);
  if (!Number.isInteger(views) || views < MIN_VIEWS || views > MAX_VIEWS)
    throw new CliError(`--views must be ${MIN_VIEWS}-${MAX_VIEWS}`);

  const file = await resolveEnvFile(ctx, a.file);
  if (!(await guard(ctx, file, Boolean(a.force)))) {
    io.out(`${s.info} Cancelled. Nothing was shared.`);
    return 1;
  }

  let passphrase: string | undefined;
  if (a.passphrase) {
    passphrase =
      process.env.ENVDROP_PASSPHRASE || (await io.askHidden('Passphrase (min 8 chars): '));
    if (passphrase.length < 8) throw new CliError('Passphrase must be at least 8 characters.');
    if (!process.env.ENVDROP_PASSPHRASE && io.isTTY) {
      const again = await io.askHidden('Confirm passphrase: ');
      if (again !== passphrase)
        throw new CliError('Passphrases did not match. Nothing was shared.');
    }
  }

  const content = await fs.readFile(file, 'utf8');
  const keyCount = parseEnv(content).entries.size;
  const res = await spin(
    io,
    c,
    passphrase ? 'Deriving key & encrypting locally…' : 'Encrypting locally (AES-256-GCM)…',
    () =>
      share({
        serverUrl: ctx.serverUrl,
        name: path.basename(file),
        content,
        ttlSeconds: EXPIRY_OPTIONS[expiry],
        maxViews: views,
        passphrase,
        fetchImpl: ctx.fetchImpl,
        scrypt: ctx.fastKdf ? { N: 2 ** 14, r: 8, p: 1 } : undefined,
      }),
  );
  await ctx.store.add({
    id: res.id,
    origin: res.origin,
    revokeToken: res.revokeToken,
    expiresAt: res.expiresAt,
    fileName: path.basename(file),
    createdAt: Date.now(),
    maxViews: views,
  });

  const copied =
    a.copy !== false && io.isTTY ? await (ctx.copy ?? copyToClipboard)(res.link) : false;
  io.out('');
  io.out(
    box(c, [
      `${s.lock} ${c.bold(path.basename(file))} ${c.dim(`· ${keyCount} keys sealed`)}`,
      '',
      c.cyan(res.link),
      '',
      `${c.dim('expires')} ${fmtLeft(res.expiresAt - Date.now())}   ${c.dim('views')} ${views === 1 ? '1 (burn after read)' : views}   ${c.dim('passphrase')} ${passphrase ? c.green('yes') : 'no'}`,
    ]),
  );
  if (copied) io.out(`${s.ok} Link copied to clipboard.`);
  if (passphrase)
    io.out(`${s.info} Send the passphrase through a different channel than the link.`);
  if (a.qr) {
    io.out('');
    io.out(qrTerminal(res.link));
  }
  io.out(c.dim(`  Revoke any time: envdrop revoke ${res.id}`));
  return 0;
}

export interface PullArgs {
  link?: string;
  out?: string;
  replace?: boolean;
  merge?: boolean;
  yes?: boolean;
}

export async function pullCmd(ctx: Ctx, a: PullArgs): Promise<number> {
  const { io, c } = ctx;
  const s = sym(c);
  if (a.link)
    io.err(
      c.dim(
        'Tip: links passed as arguments end up in your shell history. Run `envdrop pull` and paste instead.',
      ),
    );
  const link = (a.link ?? (await io.askHidden('Paste the EnvDrop link (hidden): '))).trim();
  if (!parseShareLink(link))
    throw new CliError('Not a complete EnvDrop link (https://host/s/<id>#<key>).');

  const fetched = await spin(io, c, 'Downloading ciphertext…', () =>
    fetchShare(link, ctx.fetchImpl),
  );
  let payload;
  if (needsPassphrase(fetched.envelope)) {
    const fromEnv = process.env.ENVDROP_PASSPHRASE;
    for (let i = 0; i < (fromEnv ? 1 : 5) && !payload; i++) {
      const pass =
        fromEnv || (await io.askHidden(i === 0 ? 'Passphrase: ' : 'Wrong passphrase, try again: '));
      try {
        payload = await spin(io, c, 'Deriving key…', () => decryptShare(fetched, pass));
      } catch (e) {
        if (!(e instanceof DecryptionError)) throw e;
      }
    }
    if (!payload) throw new CliError('Could not decrypt: wrong passphrase.');
  } else {
    payload = await decryptShare(fetched);
  }
  io.out(
    `${s.ok} Decrypted locally ${c.dim(`· ${fetched.viewsLeft > 0 ? `${fetched.viewsLeft} view(s) left` : 'link is now burned 🔥'}`)}`,
  );

  const target = path.resolve(ctx.cwd, a.out ?? safeIncomingName(payload.name));
  let localText: string | undefined;
  try {
    localText = await fs.readFile(target, 'utf8');
  } catch {
    localText = undefined;
  }
  const incoming = parseEnv(payload.content);
  const M = c.dim('••••••••');

  if (localText === undefined) {
    io.out(
      `\n${c.bold(`New file ${rel(ctx, target)}`)} ${c.dim(`(${incoming.entries.size} keys, values masked)`)}`,
    );
    for (const k of incoming.entries.keys()) io.out(`  ${c.green('+')} ${k.padEnd(28)} ${M}`);
    if (!a.yes && !(await confirm(io, '\nWrite it?'))) return 1;
    await fs.writeFile(target, payload.content, { mode: 0o600 });
  } else {
    const d = diffEnv(parseEnv(localText), incoming);
    io.out(`\n${c.bold(`Changes to ${rel(ctx, target)}`)} ${c.dim('(values masked)')}`);
    for (const k of d.added) io.out(`  ${c.green('+')} ${k.padEnd(28)} ${c.green('new')}`);
    for (const k of d.changed) io.out(`  ${c.yellow('~')} ${k.padEnd(28)} ${c.yellow('changed')}`);
    for (const k of d.removed)
      io.out(`  ${c.red('-')} ${k.padEnd(28)} ${c.red('only in local (kept unless you replace)')}`);
    io.out(c.dim(`  ${d.unchanged.length} unchanged`));
    if (d.added.length + d.changed.length + d.removed.length === 0) {
      io.out(`${s.ok} Already up to date. Nothing to do.`);
      return 0;
    }
    let mode: 'merge' | 'replace' | 'cancel' = a.replace ? 'replace' : 'merge';
    if (!a.replace && !a.merge && !a.yes) {
      mode = await choose(
        io,
        c,
        '\nWhat should I do?',
        [
          [
            'merge',
            `Merge: apply ${d.added.length} new + ${d.changed.length} changed keys, keep everything else`,
          ],
          ['replace', 'Replace the whole file'],
          ['cancel', 'Cancel'],
        ],
        'merge',
      );
    }
    if (mode === 'cancel') {
      io.out(`${s.info} Nothing was written.`);
      return 1;
    }
    const backup = await backupFile(target);
    const backupCheck = await checkIgnored(backup);
    if (backupCheck.status === 'not-ignored') {
      const dir = backupCheck.repoRoot ?? path.dirname(target);
      await addToGitignore(dir, gitignoreEntriesFor(target, dir));
    }
    const next =
      mode === 'replace'
        ? payload.content
        : mergeEnv(localText, payload.content, { apply: [...d.added, ...d.changed] });
    await fs.writeFile(target, next, { mode: 0o600 });
    io.out(`${s.ok} Backup saved as ${rel(ctx, backup)}`);
  }
  io.out(`${s.ok} Wrote ${c.bold(rel(ctx, target))}`);
  const check = await checkIgnored(target);
  if (check.status === 'not-ignored' || check.status === 'tracked') {
    io.out(`${s.warn} ${rel(ctx, target)} is not gitignored.`);
    if (await confirm(io, `${s.git} Add it to .gitignore?`)) {
      const dir = check.repoRoot ?? path.dirname(target);
      await addToGitignore(dir, gitignoreEntriesFor(target, dir));
      io.out(`${s.ok} Protected.`);
    }
  }
  return 0;
}

export async function revokeCmd(ctx: Ctx, a: { id?: string; all?: boolean }): Promise<number> {
  const { io, c } = ctx;
  const s = sym(c);
  const links = await ctx.store.list();
  const targets = a.all ? links : a.id ? links.filter((l) => l.id === a.id) : [];
  if (!a.all && !a.id) {
    if (links.length === 0) {
      io.out(`${s.info} No active links created from this machine.`);
      return 0;
    }
    io.out(c.bold('Active links (newest first):'));
    links.forEach((l) =>
      io.out(
        `  ${c.violet(l.id)}  ${l.fileName.padEnd(18)} ${c.dim(`${fmtLeft(l.expiresAt - Date.now())} left · ${new URL(l.origin).host}`)}`,
      ),
    );
    io.out(c.dim('\nRevoke one: envdrop revoke <id>   · all: envdrop revoke --all'));
    return 0;
  }
  if (targets.length === 0)
    throw new CliError('No such link in the local list (it may have expired).');
  for (const l of targets) {
    const ok = await new ApiClient(l.origin, ctx.fetchImpl).revoke(l.id, l.revokeToken);
    await ctx.store.remove(l.id);
    io.out(
      `${ok ? s.ok : s.info} ${l.fileName} ${c.dim(l.id)} ${ok ? 'revoked' : 'was already gone'}`,
    );
  }
  return 0;
}

export async function scanCmd(ctx: Ctx, a: { staged?: boolean; files: string[] }): Promise<number> {
  const { io, c } = ctx;
  const s = sym(c);
  let reports: { file: string; filenameReason?: string; findings: ReturnType<typeof scanText> }[] =
    [];
  if (a.staged || a.files.length === 0) {
    reports = await scanStaged(ctx.cwd, {
      ignorePatterns: (process.env.ENVDROP_IGNORE ?? '').split(',').filter(Boolean),
    });
  } else {
    for (const f of a.files) {
      const text = await fs.readFile(path.resolve(ctx.cwd, f), 'utf8');
      const findings = scanText(text);
      if (findings.length) reports.push({ file: f, findings });
    }
  }
  if (reports.length === 0) {
    io.out(
      `${s.ok} ${c.green('No secrets found')} ${c.dim(a.staged || a.files.length === 0 ? 'in staged changes' : '')}`,
    );
    return 0;
  }
  io.err(`${s.err} ${c.bold(c.red('EnvDrop blocked this: possible secrets'))}`);
  for (const r of reports) {
    io.err(
      `  ${s.git} ${c.bold(r.file)}${r.filenameReason ? c.yellow(`  (${r.filenameReason.replace(/-/g, ' ')})`) : ''}`,
    );
    for (const f of r.findings)
      io.err(`     ${c.dim(`line ${f.line}`)}  ${f.type}  ${c.dim(f.masked)}`);
  }
  io.err(c.dim('\n  Unstage:  git restore --staged <file>   · ignore: add to .gitignore'));
  io.err(
    c.dim(
      '  False positive? add "envdrop:allow" in a comment on that line, or commit with --no-verify.',
    ),
  );
  return 1;
}

export async function hookCmd(ctx: Ctx, action: string | undefined): Promise<number> {
  const { io, c } = ctx;
  const s = sym(c);
  if (action === 'uninstall') {
    const ok = await uninstallHook(ctx.cwd);
    io.out(
      ok ? `${s.ok} Removed the EnvDrop pre-commit hook.` : `${s.info} No EnvDrop hook installed.`,
    );
    return 0;
  }
  if (action !== 'install') throw new CliError('Usage: envdrop hook install | uninstall');
  const { file } = await installHook(ctx.cwd);
  io.out(`${s.ok} ${s.git} Installed git pre-commit hook: ${c.dim(rel(ctx, file))}`);
  io.out(
    c.dim(
      '  Commits that stage .env files or obvious secrets are now blocked. Bypass once: git commit --no-verify',
    ),
  );
  return 0;
}

export async function exampleCmd(ctx: Ctx, a: { file?: string }): Promise<number> {
  const { io, c } = ctx;
  const s = sym(c);
  const file = await resolveEnvFile(ctx, a.file);
  const out = path.join(path.dirname(file), '.env.example');
  let existing: string | undefined;
  try {
    existing = await fs.readFile(out, 'utf8');
  } catch {
    existing = undefined;
  }
  const next = generateExample(await fs.readFile(file, 'utf8'), existing);
  if (existing === next) {
    io.out(`${s.ok} ${rel(ctx, out)} is already up to date.`);
    return 0;
  }
  await fs.writeFile(out, next);
  io.out(
    `${s.ok} Wrote ${c.bold(rel(ctx, out))} ${c.dim(`(${parseEnv(next).entries.size} keys, values stripped). Safe to commit.`)}`,
  );
  const check = await checkIgnored(out);
  if (check.status === 'ignored')
    io.out(
      `${s.warn} It's gitignored (probably by ".env*"). Add ${c.bold('!.env.example')} to .gitignore so teammates get it.`,
    );
  return 0;
}

export async function checkCmd(ctx: Ctx, a: { file?: string }): Promise<number> {
  const { io, c } = ctx;
  const s = sym(c);
  const file = await resolveEnvFile(ctx, a.file);
  const example = ['.env.example', '.env.sample', '.env.template'].map((n) =>
    path.join(path.dirname(file), n),
  );
  let exPath: string | undefined;
  for (const p of example) {
    try {
      await fs.access(p);
      exPath = p;
      break;
    } catch {
      /* next */
    }
  }
  if (!exPath) throw new CliError('No .env.example next to it. Create one with: envdrop example');
  const r = checkKeys(await fs.readFile(file, 'utf8'), await fs.readFile(exPath, 'utf8'));
  io.out(c.bold(`${rel(ctx, file)} vs ${rel(ctx, exPath)}`));
  for (const k of r.missing) io.out(`  ${c.red('✖ missing')}       ${k}`);
  for (const k of r.empty) io.out(`  ${c.yellow('○ empty')}         ${k}`);
  for (const k of r.extra) io.out(`  ${c.cyan('? undocumented')}  ${k}`);
  io.out(
    `${r.missing.length ? s.err : s.ok} ${r.ok} ok · ${r.missing.length} missing · ${r.empty.length} empty · ${r.extra.length} undocumented`,
  );
  return r.missing.length ? 1 : 0;
}
