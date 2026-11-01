import * as vscode from 'vscode';
import {
  checkGitignoreCommand,
  checkKeysCommand,
  checkOnOpen,
  type Deps,
  generateExampleCommand,
  pullCommand,
  revokeCommand,
  shareCommand,
} from './vscode/commands';
import { EnvState } from './vscode/envState';
import { EnvDecorations, GuardStatusBar } from './vscode/guardUi';
import { HomeViewProvider } from './vscode/homeView';
import { PrecommitWatcher } from './vscode/precommitWatcher';
import { RevokeStore } from './vscode/revokeStore';

export function activate(context: vscode.ExtensionContext): void {
  const store = new RevokeStore(context.secrets);
  const state = new EnvState();
  const deps: Deps = { context, store, state };
  const learnMore = () =>
    void vscode.commands.executeCommand(
      'markdown.showPreview',
      vscode.Uri.joinPath(context.extensionUri, 'README.md'),
    );
  const home = new HomeViewProvider(context, state, store);

  context.subscriptions.push(
    state,
    home,
    vscode.window.registerWebviewViewProvider(HomeViewProvider.viewId, home),
    vscode.window.registerFileDecorationProvider(new EnvDecorations(state)),
    new GuardStatusBar(state),
    vscode.commands.registerCommand('envdrop.share', (uri?: vscode.Uri) => shareCommand(deps, uri)),
    vscode.commands.registerCommand('envdrop.pull', () => pullCommand(deps)),
    vscode.commands.registerCommand('envdrop.revoke', () => revokeCommand(deps)),
    vscode.commands.registerCommand('envdrop.checkGitignore', (uri?: vscode.Uri) =>
      checkGitignoreCommand(deps, uri),
    ),
    vscode.commands.registerCommand('envdrop.generateExample', (uri?: vscode.Uri) =>
      generateExampleCommand(deps, uri),
    ),
    vscode.commands.registerCommand('envdrop.checkKeys', (uri?: vscode.Uri) =>
      checkKeysCommand(deps, uri),
    ),
    vscode.commands.registerCommand('envdrop.learnMore', learnMore),
    vscode.commands.registerCommand('envdrop.refresh', () => state.refresh()),
  );

  if (vscode.workspace.isTrusted) {
    const watcher = new PrecommitWatcher(learnMore);
    context.subscriptions.push(watcher);
    void watcher.start();
  }
  context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => void state.refresh()));
  void checkOnOpen(deps);
}

export function deactivate(): void {}
