import * as vscode from 'vscode';
import {
  checkGitignoreCommand,
  checkOnOpen,
  pullCommand,
  revokeCommand,
  shareCommand,
} from './vscode/commands';
import { PrecommitWatcher } from './vscode/precommitWatcher';
import { RevokeStore } from './vscode/revokeStore';

export function activate(context: vscode.ExtensionContext): void {
  const store = new RevokeStore(context.secrets);
  const learnMore = () =>
    void vscode.commands.executeCommand(
      'markdown.showPreview',
      vscode.Uri.joinPath(context.extensionUri, 'README.md'),
    );

  context.subscriptions.push(
    vscode.commands.registerCommand('envdrop.share', (uri?: vscode.Uri) =>
      shareCommand(store, uri),
    ),
    vscode.commands.registerCommand('envdrop.pull', () => pullCommand(context)),
    vscode.commands.registerCommand('envdrop.revoke', () => revokeCommand(store)),
    vscode.commands.registerCommand('envdrop.checkGitignore', (uri?: vscode.Uri) =>
      checkGitignoreCommand(uri),
    ),
    vscode.commands.registerCommand('envdrop.learnMore', learnMore),
    vscode.commands.registerCommand('envdrop.menu', async () => {
      const pick = await vscode.window.showQuickPick(
        [
          { label: '$(cloud-upload) Share .env', cmd: 'envdrop.share' },
          { label: '$(cloud-download) Pull .env', cmd: 'envdrop.pull' },
          { label: '$(circle-slash) Revoke link', cmd: 'envdrop.revoke' },
          { label: '$(shield) Check .gitignore', cmd: 'envdrop.checkGitignore' },
        ],
        { title: 'EnvDrop' },
      );
      if (pick) await vscode.commands.executeCommand(pick.cmd);
    }),
  );

  const status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 0);
  status.text = '$(lock) EnvDrop';
  status.tooltip = 'EnvDrop: share or pull .env files (end-to-end encrypted)';
  status.command = 'envdrop.menu';
  status.show();
  context.subscriptions.push(status);

  if (vscode.workspace.isTrusted) {
    const watcher = new PrecommitWatcher(learnMore);
    context.subscriptions.push(watcher);
    void watcher.start();
  }
  void checkOnOpen(context);
}

export function deactivate(): void {}
