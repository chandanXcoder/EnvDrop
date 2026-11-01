import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import {
  addToGitignore,
  ApiClient,
  backupFile,
  decryptShare,
  type FetchedShare,
  fetchShare,
  gitignoreEntriesFor,
  normalizeServerUrl,
  safeIncomingName,
  share,
} from '@envdrop/core';
import {
  DecryptionError,
  EXPIRY_OPTIONS,
  type ExpiryOption,
  generateExample,
  MAX_PLAINTEXT_BYTES,
  mergeEnv,
  needsPassphrase,
  parseEnv,
  parseShareLink,
  type SharePayload,
} from '@envdrop/shared';
import * as vscode from 'vscode';
import { cfg, EXPIRY_LABELS } from './config';
import { showEnvReview } from './diffWebview';
import { type EnvFileInfo, type EnvState, envKind, findExample } from './envState';
import { ensureGitignored, gitignoreDirFor, ignoreCheck, relTo } from './gitGuard';
import { showKeysPanel } from './keysPanel';
import type { RevokeStore } from './revokeStore';
import { showSharePanel } from './sharePanel';

export interface Deps {
  context: vscode.ExtensionContext;
  store: RevokeStore;
  state: EnvState;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : 'Unexpected error';
}

function formatExpiry(expiresAt: number): string {
  const mins = Math.max(1, Math.round((expiresAt - Date.now()) / 60_000));
  return mins >= 120 ? `${Math.round(mins / 60)} h` : `${mins} min`;
}

const ENV_ICON: Record<string, string> = {
  base: '$(file-code)',
  local: '$(device-desktop)',
  development: '$(beaker)',
  staging: '$(rocket)',
  production: '$(flame)',
  test: '$(check-all)',
  other: '$(file)',
};
const GIT_LABEL: Record<string, string> = {
  ignored: '$(lock) gitignored',
  'not-ignored': '$(warning) NOT gitignored',
  tracked: '$(error) tracked by git',
  'no-repo': '$(circle-slash) no git repo',
};

/** Environment-aware picker (.env, .env.development, .env.staging, .env.production…). */
async function pickEnvFile(
  state: EnvState,
  title: string,
  arg?: vscode.Uri,
): Promise<string | undefined> {
  if (arg?.scheme === 'file') return arg.fsPath;
  await state.refresh();
  const files = [...state.files];
  const active = vscode.window.activeTextEditor?.document.uri;
  if (active?.scheme === 'file') {
    const i = files.findIndex((f) => f.path === active.fsPath);
    if (i > 0) files.unshift(...files.splice(i, 1));
  }
  if (files.length === 1) return files[0]!.path;
  type Item = vscode.QuickPickItem & { file?: EnvFileInfo; browse?: boolean };
  const items: Item[] = files.map((f) => ({
    label: `${ENV_ICON[f.env]} ${f.name}`,
    description: `${f.env === 'other' || f.env === 'base' ? '' : f.env + ' · '}${f.keyCount} keys · ${GIT_LABEL[f.ignore]}`,
    detail: f.rel !== f.name ? f.rel : undefined,
    file: f,
  }));
  if (items.length) items.push({ label: '', kind: vscode.QuickPickItemKind.Separator });
  items.push({ label: '$(folder-opened) Choose another file…', browse: true });
  const pick =
    files.length === 0
      ? items[items.length - 1]
      : await vscode.window.showQuickPick(items, { title, matchOnDescription: true });
  if (!pick) return undefined;
  if (pick.browse) {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: 'Select',
      title,
    });
    return uris?.[0]?.fsPath;
  }
  return pick.file?.path;
}

export async function shareCommand(
  { context, store, state }: Deps,
  arg?: vscode.Uri,
): Promise<void> {
  const c = cfg();
  try {
    normalizeServerUrl(c.serverUrl);
  } catch (e) {
    void vscode.window
      .showErrorMessage(`EnvDrop: ${errMsg(e)}`, 'Open Settings')
      .then(
        (p) =>
          p && vscode.commands.executeCommand('workbench.action.openSettings', 'envdrop.serverUrl'),
      );
    return;
  }
  const file = await pickEnvFile(state, 'EnvDrop: which environment do you want to share?', arg);
  if (!file) return;
  if (!(await ensureGitignored(file, 'share'))) return;
  void state.refresh();

  const kind = envKind(path.basename(file));
  if (kind === 'production') {
    const ok = await vscode.window.showWarningMessage(
      `You're about to share PRODUCTION secrets (${path.basename(file)}).`,
      { modal: true, detail: 'Consider a short expiry, a single view and a passphrase.' },
      'Continue',
    );
    if (ok !== 'Continue') return;
  }

  const expiryItems = (Object.keys(EXPIRY_OPTIONS) as ExpiryOption[]).map((k) => ({
    label: `$(watch) ${EXPIRY_LABELS[k]}`,
    key: k,
    description: k === c.defaultExpiry ? 'default' : undefined,
  }));
  expiryItems.sort((a, b) => (a.key === c.defaultExpiry ? -1 : b.key === c.defaultExpiry ? 1 : 0));
  const expiry = await vscode.window.showQuickPick(expiryItems, {
    title: 'EnvDrop: the link self-destructs after… (step 1/3)',
  });
  if (!expiry) return;

  const viewChoices = [...new Set([c.defaultMaxViews, 1, 2, 3, 5, 10])];
  const views = await vscode.window.showQuickPick(
    viewChoices.map((n) => ({
      label: n === 1 ? '$(flame) 1 view: burn after reading' : `$(eye) ${n} views`,
      n,
      description: n === c.defaultMaxViews ? 'default' : undefined,
    })),
    { title: 'EnvDrop: how many times can it be opened? (step 2/3)' },
  );
  if (!views) return;

  const passphrase = await vscode.window.showInputBox({
    title: 'EnvDrop: optional passphrase (step 3/3)',
    prompt:
      'Press Enter to skip. If set, the recipient needs the link AND this passphrase. Send it through a different channel.',
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

  try {
    const res = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'EnvDrop', cancellable: false },
      async (p) => {
        p.report({ message: passphrase ? 'Deriving key from passphrase…' : 'Encrypting locally…' });
        const r = await share({
          serverUrl: c.serverUrl,
          name: path.basename(file),
          content,
          ttlSeconds: EXPIRY_OPTIONS[expiry.key],
          maxViews: views.n,
          passphrase: passphrase || undefined,
        });
        p.report({ message: 'Uploaded ciphertext ✓' });
        return r;
      },
    );
    const createdAt = Date.now();
    await store.add({
      id: res.id,
      origin: res.origin,
      revokeToken: res.revokeToken,
      expiresAt: res.expiresAt,
      fileName: path.basename(file),
      createdAt,
      maxViews: views.n,
    });
    await vscode.env.clipboard.writeText(res.link);
    vscode.window.setStatusBarMessage('$(check) EnvDrop: link copied to clipboard', 5000);
    showSharePanel(context, store, {
      ...res,
      fileName: path.basename(file),
      keyCount: parseEnv(content).entries.size,
      createdAt,
      maxViews: views.n,
      passphrase: Boolean(passphrase),
    });
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
    title: prefill
      ? 'EnvDrop: link found on your clipboard. Press Enter to pull'
      : 'EnvDrop: paste the share link',
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
          : `Wrong passphrase, try again (${5 - attempt} left).`,
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

export async function pullCommand({ context, state }: Deps): Promise<void> {
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
      `This link points to ${parsed.origin}, not your configured EnvDrop server.`,
      {
        modal: true,
        detail: 'Only continue if you trust the sender. An env file can change how your tools run.',
      },
      'Continue',
    );
    if (ok !== 'Continue') return;
  }

  try {
    const fetched = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: 'EnvDrop: downloading ciphertext…' },
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
          ? 'EnvDrop: cancelled, nothing was written. This link is now burned; ask the sender for a new one if needed.'
          : 'EnvDrop: cancelled, nothing was written.',
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
    vscode.window.setStatusBarMessage(`$(check) EnvDrop: ${summary}`, 6000);
    void vscode.window.showInformationMessage(
      `EnvDrop: ${summary} in ${relTo(target)}.${backupPath ? ` Backup: ${path.basename(backupPath)}.` : ''}`,
    );
    await ensureGitignored(target, 'pull');
    void state.refresh();
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

export async function revokeCommand({ store }: Deps): Promise<void> {
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
        description: `$(watch) ${formatExpiry(l.expiresAt)} left · ${l.maxViews} view(s) max`,
        detail: `${new URL(l.origin).host} · created ${new Date(l.createdAt).toLocaleString()}`,
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

export async function checkGitignoreCommand({ state }: Deps, arg?: vscode.Uri): Promise<void> {
  await state.refresh();
  const files = arg?.scheme === 'file' ? [arg.fsPath] : state.files.map((f) => f.path);
  if (files.length === 0) {
    void vscode.window.showInformationMessage('EnvDrop: no env files found in the workspace.');
    return;
  }
  let allGood = true;
  for (const f of files) {
    const s = await ignoreCheck(f);
    if (s.status === 'not-ignored' || s.status === 'tracked') {
      allGood = false;
      await ensureGitignored(f, 'fix');
    }
  }
  void state.refresh();
  if (allGood)
    void vscode.window.showInformationMessage(
      `EnvDrop: ${files.length} env file(s) checked, all protected by .gitignore.`,
    );
}

/** One-time, dismissible check on workspace open. */
export async function checkOnOpen({ context, state }: Deps): Promise<void> {
  if (!cfg().checkGitignoreOnOpen) return;
  if (context.workspaceState.get<boolean>('envdrop.dontShowGitignoreWarning')) return;
  await state.refresh();
  const bad = state.problems;
  if (bad.length === 0) return;
  const names = bad.map((f) => f.rel).join(', ');
  const fix = 'Protect now';
  const show = 'Show me';
  const never = "Don't show again";
  const pick = await vscode.window.showWarningMessage(
    `EnvDrop: ${names} ${bad.length === 1 ? 'is' : 'are'} not protected by .gitignore and could be committed by accident.`,
    fix,
    show,
    never,
  );
  if (pick === never) await context.workspaceState.update('envdrop.dontShowGitignoreWarning', true);
  if (pick === show) await vscode.commands.executeCommand('envdrop.home.focus');
  if (pick === fix) {
    for (const f of bad) await ensureGitignored(f.path, 'fix');
    void state.refresh();
  }
}

/** Phase 2: create or update .env.example next to an env file (values stripped). */
export async function generateExampleCommand({ state }: Deps, arg?: vscode.Uri): Promise<void> {
  const file = await pickEnvFile(state, 'EnvDrop: generate .env.example from which file?', arg);
  if (!file) return;
  const envText = await fs.readFile(file, 'utf8');
  const examplePath = (await findExample(file)) ?? path.join(path.dirname(file), '.env.example');
  const existing = (await exists(examplePath)) ? await fs.readFile(examplePath, 'utf8') : undefined;
  const next = generateExample(envText, existing);
  if (existing !== undefined) {
    if (existing === next) {
      void vscode.window.showInformationMessage(
        `EnvDrop: ${path.basename(examplePath)} is already up to date.`,
      );
      return;
    }
    const ok = await vscode.window.showInformationMessage(
      `Update ${relTo(examplePath)} from ${path.basename(file)}?`,
      {
        modal: true,
        detail:
          'Keys and comments are synced, values are stripped, and placeholders you wrote in the example are kept.',
      },
      'Update',
    );
    if (ok !== 'Update') return;
  }
  await fs.writeFile(examplePath, next, 'utf8');
  await vscode.window.showTextDocument(vscode.Uri.file(examplePath), { preview: true });

  // A `.env*` rule also hides the example from git, which is a common gotcha.
  const check = await ignoreCheck(examplePath);
  if (check.status === 'ignored') {
    const add = 'Allow in .gitignore';
    const pick = await vscode.window.showWarningMessage(
      `${path.basename(examplePath)} is gitignored (probably by a ".env*" rule), so teammates won't get it.`,
      add,
    );
    if (pick === add) {
      const dir = gitignoreDirFor(examplePath, check);
      const rel = path.relative(dir, examplePath).split(path.sep).join('/');
      await addToGitignore(dir, [`!${rel.includes('/') ? '/' + rel : path.basename(examplePath)}`]);
    }
  }
  void vscode.window.showInformationMessage(
    `EnvDrop: wrote ${relTo(examplePath)} (${parseEnv(next).entries.size} keys, no values). Safe to commit.`,
  );
  void state.refresh();
}

/** Phase 2: compare .env with .env.example. */
export async function checkKeysCommand(deps: Deps, arg?: vscode.Uri): Promise<void> {
  const file = await pickEnvFile(deps.state, 'EnvDrop: check keys of which env file?', arg);
  if (!file) return;
  const example = await findExample(file);
  if (!example) {
    const gen = 'Generate .env.example';
    const pick = await vscode.window.showInformationMessage(
      `EnvDrop: there's no .env.example next to ${path.basename(file)} to compare against.`,
      gen,
    );
    if (pick === gen) await generateExampleCommand(deps, vscode.Uri.file(file));
    return;
  }
  await showKeysPanel(deps.context, file, example);
}
