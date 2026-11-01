import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  DecryptionError,
  EXPIRY_OPTIONS,
  type ExpiryOption,
  MAX_PLAINTEXT_BYTES,
  mergeEnv,
  needsPassphrase,
  parseEnv,
  parseShareLink,
  type SharePayload,
} from '@envdrop/shared';
import * as vscode from 'vscode';
import { ApiClient, normalizeServerUrl } from '../core/apiClient';
import { backupFile, findEnvFiles, isShareableEnvFile, safeIncomingName } from '../core/envFiles';
import {
  addToGitignore,
  checkIgnored,
  defaultGitRunner,
  type GitRunner,
  gitignoreEntriesFor,
  type IgnoreCheck,
  untrack,
} from '../core/gitignore';
import { decryptShare, type FetchedShare, fetchShare, share } from '../core/shareService';
import { cfg, EXPIRY_LABELS } from './config';
import { showEnvReview } from './diffWebview';
import type { RevokeStore } from './revokeStore';

/** In untrusted workspaces we never spawn git (repo config such as core.fsmonitor can run code). */
export function gitRunner(): GitRunner {
  if (vscode.workspace.isTrusted) return defaultGitRunner;
  return async () => {
    throw Object.assign(new Error('untrusted workspace'), { code: 'ENOENT' });
  };
}

export function ignoreCheck(file: string): Promise<IgnoreCheck> {
  return checkIgnored(file, { git: gitRunner() });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'Unexpected error';
}

function relTo(file: string): string {
  return vscode.workspace.asRelativePath(file, true);
}

function formatExpiry(expiresAt: number): string {
  const mins = Math.max(1, Math.round((expiresAt - Date.now()) / 60_000));
  return mins >= 120 ? `${Math.round(mins / 60)} h` : `${mins} min`;
}

/** Returns the folder whose .gitignore should get the entry (repo root, else workspace folder). */
function gitignoreDirFor(file: string, check: IgnoreCheck): string {
  return (
    check.repoRoot ??
    vscode.workspace.getWorkspaceFolder(vscode.Uri.file(file))?.uri.fsPath ??
    path.dirname(file)
  );
}

/**
 * Warns if `file` is not protected by .gitignore. Resolves to true if the caller should
 * continue (protected now, or the user chose to proceed anyway).
 */
export async function ensureGitignored(
  file: string,
  context: 'share' | 'pull' | 'open',
): Promise<boolean> {
  const check = await ignoreCheck(file);
  if (check.status === 'ignored' || check.status === 'no-repo') return true;
  const rel = relTo(file);
  const dir = gitignoreDirFor(file, check);

  if (check.status === 'tracked') {
    const stop = 'Stop tracking & add to .gitignore';
    const anyway = context === 'share' ? 'Share anyway' : 'Continue';
    const pick = await vscode.window.showWarningMessage(
      `"${rel}" is tracked by git: it is (or will be) committed, and may already be in your history. Rotate any secrets that were pushed.`,
      { modal: context !== 'open' },
      stop,
      anyway,
    );
    if (pick === stop) {
      await untrack(file, gitRunner());
      await addToGitignore(dir, gitignoreEntriesFor(file, dir));
      void vscode.window.showInformationMessage(
        `EnvDrop: "${rel}" is no longer tracked and is now in .gitignore. Commit the change to .gitignore.`,
      );
      return true;
    }
    return pick === anyway;
  }

  const add = 'Add to .gitignore';
  const anyway = context === 'share' ? 'Share anyway' : 'Continue';
  const pick = await vscode.window.showWarningMessage(
    `"${rel}" is not covered by .gitignore, so it could be committed by accident.`,
    { modal: context !== 'open' },
    add,
    anyway,
  );
  if (pick === add) {
    await addToGitignore(dir, gitignoreEntriesFor(file, dir));
    void vscode.window.showInformationMessage(
      `EnvDrop: added "${path.basename(file)}" to ${relTo(path.join(dir, '.gitignore'))}.`,
    );
    return true;
  }
  return pick === anyway;
}

async function pickEnvFile(arg?: vscode.Uri): Promise<string | undefined> {
  if (arg?.scheme === 'file') return arg.fsPath;
  const active = vscode.window.activeTextEditor?.document.uri;
  const folders = vscode.workspace.workspaceFolders ?? [];
  const found = (await Promise.all(folders.map((f) => findEnvFiles(f.uri.fsPath)))).flat();
  if (
    active?.scheme === 'file' &&
    isShareableEnvFile(active.fsPath) &&
    !found.includes(active.fsPath)
  ) {
    found.unshift(active.fsPath);
  }
  if (found.length === 1) return found[0];
  const browse = '$(folder-opened) Choose another file…';
  const items: vscode.QuickPickItem[] = [
    ...found.map((f) => ({
      label: path.basename(f),
      description: relTo(path.dirname(f)),
      detail: f,
    })),
    { label: browse },
  ];
  const pick =
    found.length === 0
      ? { label: browse }
      : await vscode.window.showQuickPick(items, {
          title: 'EnvDrop: which env file do you want to share?',
        });
  if (!pick) return undefined;
  if (pick.label === browse) {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Share',
      title: 'Select an env file to share',
    });
    return uris?.[0]?.fsPath;
  }
  return pick.detail;
}

export async function shareCommand(store: RevokeStore, arg?: vscode.Uri): Promise<void> {
  const c = cfg();
  try {
    normalizeServerUrl(c.serverUrl);
  } catch (e) {
    void vscode.window.showErrorMessage(`EnvDrop: ${errMsg(e)}`);
    return;
  }
  const file = await pickEnvFile(arg);
  if (!file) return;
  if (!(await ensureGitignored(file, 'share'))) return;

  const expiryItems = (Object.keys(EXPIRY_OPTIONS) as ExpiryOption[]).map((k) => ({
    label: EXPIRY_LABELS[k],
    key: k,
    description: k === c.defaultExpiry ? 'default' : undefined,
  }));
  expiryItems.sort((a, b) => (a.key === c.defaultExpiry ? -1 : b.key === c.defaultExpiry ? 1 : 0));
  const expiry = await vscode.window.showQuickPick(expiryItems, {
    title: 'EnvDrop: link expires after…',
  });
  if (!expiry) return;

  const viewChoices = [...new Set([c.defaultMaxViews, 1, 2, 3, 5, 10])];
  const views = await vscode.window.showQuickPick(
    viewChoices.map((n) => ({
      label: n === 1 ? '1 view (burn after read)' : `${n} views`,
      n,
      description: n === c.defaultMaxViews ? 'default' : undefined,
    })),
    { title: 'EnvDrop: how many times can the link be opened?' },
  );
  if (!views) return;

  const passphrase = await vscode.window.showInputBox({
    title: 'EnvDrop: optional passphrase',
    prompt:
      'Leave empty for none. If set, the recipient needs the link AND this passphrase. Send it through a different channel.',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) =>
      v && v.length < 8 ? 'Use at least 8 characters (or leave empty).' : undefined,
  });
  if (passphrase === undefined) return;
  if (passphrase) {
    const again = await vscode.window.showInputBox({
      title: 'EnvDrop: confirm passphrase',
      password: true,
      ignoreFocusOut: true,
    });
    if (again !== passphrase) {
      void vscode.window.showErrorMessage(
        'EnvDrop: passphrases did not match. Nothing was shared.',
      );
      return;
    }
  }

  let content: string;
  try {
    const buf = await fs.readFile(file);
    if (buf.length > MAX_PLAINTEXT_BYTES) {
      void vscode.window.showErrorMessage(
        `EnvDrop: file is too large (${buf.length} bytes, max ${MAX_PLAINTEXT_BYTES}).`,
      );
      return;
    }
    content = buf.toString('utf8');
  } catch (e) {
    void vscode.window.showErrorMessage(`EnvDrop: could not read file: ${errMsg(e)}`);
    return;
  }
  const keyCount = parseEnv(content).entries.size;

  try {
    const res = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'EnvDrop: encrypting and uploading…',
      },
      () =>
        share({
          serverUrl: c.serverUrl,
          name: path.basename(file),
          content,
          ttlSeconds: EXPIRY_OPTIONS[expiry.key],
          maxViews: views.n,
          passphrase: passphrase || undefined,
        }),
    );
    await store.add({
      id: res.id,
      origin: res.origin,
      revokeToken: res.revokeToken,
      expiresAt: res.expiresAt,
      fileName: path.basename(file),
      createdAt: Date.now(),
      maxViews: views.n,
    });
    await vscode.env.clipboard.writeText(res.link);
    const choice = await vscode.window.showInformationMessage(
      `EnvDrop: link to ${path.basename(file)} (${keyCount} keys) COPIED TO CLIPBOARD. ` +
        `Expires in ${EXPIRY_LABELS[expiry.key]}, ${views.n === 1 ? 'burns after 1 view' : `${views.n} views`}.` +
        (passphrase ? ' Send the passphrase separately.' : '') +
        ' Anyone with the link can open it, so share it directly with the recipient.',
      'Revoke now',
      'Clear clipboard',
    );
    if (choice === 'Revoke now') await revokeOne(store, res.id, res.origin, res.revokeToken);
    if (choice === 'Clear clipboard') await vscode.env.clipboard.writeText('');
  } catch (e) {
    void vscode.window.showErrorMessage(`EnvDrop: share failed: ${errMsg(e)}`);
  }
}

async function askLink(): Promise<string | undefined> {
  let prefill = '';
  try {
    const clip = await vscode.env.clipboard.readText();
    if (parseShareLink(clip)) prefill = clip.trim();
  } catch {
    /* ignore */
  }
  return vscode.window.showInputBox({
    title: 'EnvDrop: paste the share link',
    value: prefill,
    placeHolder: 'https://…/s/<id>#<key>',
    ignoreFocusOut: true,
    password: true,
    prompt: 'The part after # is the decryption key. It is never sent to the server.',
    validateInput: (v) =>
      v.trim() === '' || parseShareLink(v)
        ? undefined
        : 'Not a complete EnvDrop link (it must include the #key part).',
  });
}

async function decryptWithPrompt(fetched: FetchedShare): Promise<SharePayload | undefined> {
  if (!needsPassphrase(fetched.envelope)) return decryptShare(fetched);
  for (let attempt = 0; attempt < 5; attempt++) {
    const pass = await vscode.window.showInputBox({
      title: 'EnvDrop: this link is passphrase-protected',
      prompt:
        attempt === 0
          ? 'Enter the passphrase the sender gave you.'
          : 'Wrong passphrase, try again.',
      password: true,
      ignoreFocusOut: true,
    });
    if (pass === undefined) return undefined;
    try {
      return await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'EnvDrop: deriving key…' },
        () => decryptShare(fetched, pass),
      );
    } catch (e) {
      if (!(e instanceof DecryptionError)) throw e;
    }
  }
  throw new DecryptionError('Too many wrong passphrase attempts.');
}

async function pickTargetFolder(): Promise<string | undefined> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length === 1) return folders[0]!.uri.fsPath;
  if (folders.length > 1) {
    const pick = await vscode.window.showWorkspaceFolderPick({
      placeHolder: 'EnvDrop: write the env file into which folder?',
    });
    return pick?.uri.fsPath;
  }
  const uris = await vscode.window.showOpenDialog({
    canSelectFolders: true,
    canSelectFiles: false,
    openLabel: 'Write here',
  });
  return uris?.[0]?.fsPath;
}

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function pullCommand(context: vscode.ExtensionContext): Promise<void> {
  const link = await askLink();
  if (!link) return;
  const parsed = parseShareLink(link)!;

  let configured: string | undefined;
  try {
    configured = normalizeServerUrl(cfg().serverUrl);
  } catch {
    configured = undefined;
  }
  if (parsed.origin !== configured) {
    const ok = await vscode.window.showWarningMessage(
      `This link points to ${parsed.origin}, not your configured EnvDrop server. Only continue if you trust the sender. The file could set variables that change how your tools run.`,
      { modal: true },
      'Continue',
    );
    if (ok !== 'Continue') return;
  }

  try {
    const fetched = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'EnvDrop: downloading…' },
      () => fetchShare(link),
    );
    const payload = await decryptWithPrompt(fetched);
    if (!payload) return;

    const folder = await pickTargetFolder();
    if (!folder) return;
    const name = safeIncomingName(payload.name);
    const target = path.join(folder, name);
    const hasLocal = await exists(target);
    const localText = hasLocal ? await fs.readFile(target, 'utf8') : undefined;

    const review = await showEnvReview(context, {
      targetName: name,
      localText,
      incomingText: payload.content,
      origin: fetched.origin,
      viewsLeft: fetched.viewsLeft,
    });
    if (!review) {
      void vscode.window.showInformationMessage(
        fetched.viewsLeft === 0
          ? 'EnvDrop: cancelled. Nothing was written. Note: this link is now burned; ask the sender for a new one if needed.'
          : 'EnvDrop: cancelled. Nothing was written.',
      );
      return;
    }

    let backupPath: string | undefined;
    if (hasLocal && review.backup) {
      backupPath = await backupFile(target);
      const bcheck = await ignoreCheck(backupPath);
      if (bcheck.status === 'not-ignored') {
        const dir = gitignoreDirFor(backupPath, bcheck);
        await addToGitignore(dir, gitignoreEntriesFor(target, dir));
      }
    }
    const next =
      review.mode === 'replace' || localText === undefined
        ? payload.content
        : mergeEnv(localText, payload.content, { apply: review.apply, remove: review.remove });
    await fs.writeFile(target, next, { encoding: 'utf8', mode: 0o600 });

    const summary =
      review.mode === 'merge' && hasLocal
        ? `updated ${review.apply.length} key(s), removed ${review.remove.length}`
        : `wrote ${parseEnv(next).entries.size} key(s)`;
    void vscode.window.showInformationMessage(
      `EnvDrop: ${summary} in ${relTo(target)}.${backupPath ? ` Backup: ${path.basename(backupPath)}.` : ''}`,
    );
    await ensureGitignored(target, 'pull');
  } catch (e) {
    void vscode.window.showErrorMessage(`EnvDrop: pull failed: ${errMsg(e)}`);
  }
}

async function revokeOne(
  store: RevokeStore,
  id: string,
  origin: string,
  token: string,
): Promise<void> {
  try {
    const ok = await new ApiClient(origin).revoke(id, token);
    await store.remove(id);
    void vscode.window.showInformationMessage(
      ok ? 'EnvDrop: link revoked.' : 'EnvDrop: link was already expired or used up.',
    );
  } catch (e) {
    void vscode.window.showErrorMessage(`EnvDrop: revoke failed: ${errMsg(e)}`);
  }
}

export async function revokeCommand(store: RevokeStore): Promise<void> {
  const links = await store.list();
  if (links.length === 0) {
    void vscode.window.showInformationMessage(
      'EnvDrop: no active links created from this machine.',
    );
    return;
  }
  const ALL = '__all__';
  const pick = await vscode.window.showQuickPick(
    [
      ...links.map((l) => ({
        label: `$(link) ${l.fileName}`,
        description: `expires in ${formatExpiry(l.expiresAt)} · ${l.maxViews} view(s) max`,
        detail: `${l.origin} · created ${new Date(l.createdAt).toLocaleString()}`,
        id: l.id,
      })),
      {
        label: '$(trash) Revoke all',
        id: ALL,
        description: `${links.length} link(s)`,
        detail: undefined,
      },
    ],
    { title: 'EnvDrop: revoke a link created from this machine' },
  );
  if (!pick) return;
  const targets = pick.id === ALL ? links : links.filter((l) => l.id === pick.id);
  for (const l of targets) await revokeOne(store, l.id, l.origin, l.revokeToken);
}

export async function checkGitignoreCommand(arg?: vscode.Uri): Promise<void> {
  const files =
    arg?.scheme === 'file'
      ? [arg.fsPath]
      : (
          await Promise.all(
            (vscode.workspace.workspaceFolders ?? []).map((f) => findEnvFiles(f.uri.fsPath)),
          )
        ).flat();
  if (files.length === 0) {
    void vscode.window.showInformationMessage(
      'EnvDrop: no env files found in the workspace root(s).',
    );
    return;
  }
  let allGood = true;
  for (const f of files) {
    const s = await ignoreCheck(f);
    if (s.status === 'not-ignored' || s.status === 'tracked') {
      allGood = false;
      await ensureGitignored(f, 'pull');
    }
  }
  if (allGood)
    void vscode.window.showInformationMessage(
      `EnvDrop: ${files.length} env file(s) checked, all are gitignored.`,
    );
}

/** One-time, dismissible check on workspace open. */
export async function checkOnOpen(context: vscode.ExtensionContext): Promise<void> {
  if (!cfg().checkGitignoreOnOpen) return;
  if (context.workspaceState.get<boolean>('envdrop.dontShowGitignoreWarning')) return;
  const folders = vscode.workspace.workspaceFolders ?? [];
  const files = (await Promise.all(folders.map((f) => findEnvFiles(f.uri.fsPath)))).flat();
  const bad: string[] = [];
  for (const f of files) {
    const s = await ignoreCheck(f);
    if (s.status === 'not-ignored' || s.status === 'tracked') bad.push(f);
  }
  if (bad.length === 0) return;
  const names = bad.map((f) => relTo(f)).join(', ');
  const fix = 'Fix';
  const never = "Don't show again";
  const pick = await vscode.window.showWarningMessage(
    `EnvDrop: ${names} ${bad.length === 1 ? 'is' : 'are'} not protected by .gitignore and could be committed by accident.`,
    fix,
    never,
  );
  if (pick === never) await context.workspaceState.update('envdrop.dontShowGitignoreWarning', true);
  if (pick === fix) for (const f of bad) await ensureGitignored(f, 'pull');
}
