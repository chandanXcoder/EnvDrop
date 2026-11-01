import { createHash } from 'node:crypto';
import * as path from 'node:path';
import { scanUnifiedDiff, type SecretFinding, sensitiveFilenameReason } from '@envdrop/shared';
import ignore from 'ignore';
import * as vscode from 'vscode';
import { addToGitignore, defaultGitRunner, gitignoreEntriesFor, untrack } from '../core/gitignore';
import { cfg } from './config';
import type { API, Change, GitExtension, Repository } from './gitApi';

const INDEX_DELETED = 2;
const MAX_DIFF_BYTES = 512 * 1024;

export interface StagedIssue {
  file: string;
  relPath: string;
  filenameReason?: string;
  findings: SecretFinding[];
  signature: string;
}

/**
 * Watches the git index through the built-in vscode.git extension and warns when an env
 * file or something that looks like a secret is staged. VS Code can't block a commit, so
 * this is a warning, not enforcement.
 */
export class PrecommitWatcher implements vscode.Disposable {
  private readonly disposables: vscode.Disposable[] = [];
  /** path -> signature of what we already warned about (or the user chose to ignore). */
  private readonly handled = new Map<string, string>();
  private readonly timers = new Map<Repository, ReturnType<typeof setTimeout>>();

  constructor(private readonly learnMore: () => void) {}

  async start(): Promise<void> {
    const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!ext) return;
    let api: API;
    try {
      const exports = ext.isActive ? ext.exports : await ext.activate();
      if (!exports.enabled) return;
      api = exports.getAPI(1);
    } catch {
      return;
    }
    api.repositories.forEach((r) => this.watch(r));
    this.disposables.push(api.onDidOpenRepository((r) => this.watch(r)));
  }

  private watch(repo: Repository) {
    this.disposables.push(repo.state.onDidChange(() => this.schedule(repo)));
    this.schedule(repo);
  }

  private schedule(repo: Repository) {
    const t = this.timers.get(repo);
    if (t) clearTimeout(t);
    this.timers.set(
      repo,
      setTimeout(() => void this.check(repo).catch(() => undefined), 750),
    );
  }

  private async check(repo: Repository) {
    const c = cfg();
    if (!c.precommitEnabled) return;
    const ig = ignore().add(c.precommitIgnorePatterns);
    const staged = repo.state.indexChanges.filter((ch: Change) => ch.status !== INDEX_DELETED);
    const stagedPaths = new Set(staged.map((ch) => ch.uri.fsPath));
    // Forget files that are no longer staged so re-staging warns again.
    for (const p of [...this.handled.keys()]) if (!stagedPaths.has(p)) this.handled.delete(p);

    for (const ch of staged) {
      const file = ch.uri.fsPath;
      const relPath = path.relative(repo.rootUri.fsPath, file).split(path.sep).join('/');
      if (!relPath || relPath.startsWith('..') || ig.ignores(relPath)) continue;
      const issue = await this.inspect(repo, file, relPath, c.precommitScanContent);
      if (!issue) continue;
      if (this.handled.get(file) === issue.signature) continue;
      this.handled.set(file, issue.signature);
      void this.notify(repo, issue);
    }
  }

  private async inspect(
    repo: Repository,
    file: string,
    relPath: string,
    scanContent: boolean,
  ): Promise<StagedIssue | undefined> {
    const filenameReason = sensitiveFilenameReason(relPath);
    let findings: SecretFinding[] = [];
    let diffHash = '';
    if (scanContent) {
      try {
        const diff = await repo.diffIndexWithHEAD(file);
        if (diff.length <= MAX_DIFF_BYTES) {
          findings = scanUnifiedDiff(diff);
          diffHash = createHash('sha256').update(diff).digest('hex');
        }
      } catch {
        /* binary or unreadable: filename check only */
      }
    }
    if (!filenameReason && findings.length === 0) return undefined;
    // Signature: hash only, never contents. Changes when the staged content changes.
    return {
      file,
      relPath,
      filenameReason,
      findings,
      signature: `${filenameReason ?? ''}:${diffHash}`,
    };
  }

  private async notify(repo: Repository, issue: StagedIssue) {
    const what = issue.filenameReason
      ? `"${issue.relPath}" is staged for commit and looks like ${
          issue.filenameReason === 'env-file'
            ? 'an env file'
            : issue.filenameReason === 'private-key-file'
              ? 'a private key'
              : 'a credentials file'
        }.`
      : `Possible secret(s) staged in "${issue.relPath}".`;
    const details = issue.findings
      .slice(0, 3)
      .map((f) => `line ${f.line}: ${f.type} (${f.masked})`)
      .join('; ');
    const more = issue.findings.length > 3 ? ` +${issue.findings.length - 3} more` : '';
    const msg = `EnvDrop: ${what}${details ? ` Found ${details}${more}.` : ''}`;

    const actions = [
      'Unstage file',
      ...(issue.filenameReason ? ['Add to .gitignore'] : []),
      'Ignore this once',
      'Learn more',
    ];
    const choice = await vscode.window.showWarningMessage(msg, ...actions);
    try {
      if (choice === 'Unstage file') {
        await this.unstage(repo, issue.file);
      } else if (choice === 'Add to .gitignore') {
        const root = repo.rootUri.fsPath;
        await addToGitignore(root, gitignoreEntriesFor(issue.file, root));
        await this.unstage(repo, issue.file);
        const tracked = await defaultGitRunner(
          ['ls-files', '--error-unmatch', '--', issue.file],
          root,
        );
        if (tracked.code === 0) {
          const stop = await vscode.window.showWarningMessage(
            `"${issue.relPath}" is already tracked by git, so .gitignore alone won't stop it being committed. Stop tracking it (keeps your local file)?`,
            'Stop tracking',
          );
          if (stop) await untrack(issue.file);
        }
        void vscode.window.showInformationMessage(
          `EnvDrop: added "${issue.relPath}" to .gitignore and unstaged it.`,
        );
      } else if (choice === 'Learn more') {
        this.learnMore();
      }
      // "Ignore this once" / dismissed: signature stays in `handled`, so we only warn again
      // if the staged content changes or the file is unstaged and staged again.
    } catch (e) {
      void vscode.window.showErrorMessage(
        `EnvDrop: ${e instanceof Error ? e.message : 'action failed'}`,
      );
    }
  }

  private async unstage(repo: Repository, file: string) {
    try {
      await repo.revert([file]);
    } catch {
      const r = await defaultGitRunner(['restore', '--staged', '--', file], repo.rootUri.fsPath);
      if (r.code !== 0) {
        await defaultGitRunner(['rm', '--cached', '--quiet', '--', file], repo.rootUri.fsPath);
      }
    }
  }

  dispose() {
    for (const t of this.timers.values()) clearTimeout(t);
    this.disposables.forEach((d) => d.dispose());
  }
}
