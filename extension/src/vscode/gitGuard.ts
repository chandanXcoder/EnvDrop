import * as path from 'node:path';
import {
  addToGitignore,
  checkIgnored,
  defaultGitRunner,
  type GitRunner,
  gitignoreEntriesFor,
  type IgnoreCheck,
  untrack,
} from '@envdrop/core';
import * as vscode from 'vscode';

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

export function relTo(file: string): string {
  return vscode.workspace.asRelativePath(file, true);
}

/** Folder whose .gitignore should get the entry (repo root, else workspace folder). */
export function gitignoreDirFor(file: string, check: IgnoreCheck): string {
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
  context: 'share' | 'pull' | 'fix',
): Promise<boolean> {
  const check = await ignoreCheck(file);
  if (check.status === 'ignored' || check.status === 'no-repo') return true;
  const rel = relTo(file);
  const dir = gitignoreDirFor(file, check);
  const anyway = context === 'share' ? 'Share anyway' : 'Leave as is';

  if (check.status === 'tracked') {
    const stop = 'Stop tracking & add to .gitignore';
    const pick = await vscode.window.showWarningMessage(
      `"${rel}" is tracked by git, so it is (or will be) committed and may already be in your history.`,
      {
        modal: true,
        detail:
          'EnvDrop can untrack it (your local copy stays) and add it to .gitignore. Rotate any secret that was ever pushed.',
      },
      stop,
      anyway,
    );
    if (pick === stop) {
      await untrack(file, gitRunner());
      await addToGitignore(dir, gitignoreEntriesFor(file, dir));
      void vscode.window.showInformationMessage(
        `EnvDrop: "${rel}" is untracked and gitignored. Commit the .gitignore change.`,
      );
      return true;
    }
    return pick === anyway;
  }

  const add = 'Add to .gitignore';
  const pick = await vscode.window.showWarningMessage(
    `"${rel}" is not covered by .gitignore, so it could be committed by accident.`,
    {
      modal: true,
      detail: `EnvDrop will append "${gitignoreEntriesFor(file, dir)[0]}" (and its .backup) to ${relTo(path.join(dir, '.gitignore'))}.`,
    },
    add,
    anyway,
  );
  if (pick === add) {
    await addToGitignore(dir, gitignoreEntriesFor(file, dir));
    void vscode.window.showInformationMessage(
      `EnvDrop: "${path.basename(file)}" is now protected by .gitignore.`,
    );
    return true;
  }
  return pick === anyway;
}
