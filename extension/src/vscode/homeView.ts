import * as vscode from 'vscode';
import { ApiClient } from '@envdrop/core';
import { cfg } from './config';
import type { EnvState } from './envState';
import { ensureGitignored } from './gitGuard';
import type { RevokeStore } from './revokeStore';
import { ISSUES_URL, REPO_URL, renderHtml, webviewOptions } from './webview';

/** Sidebar home: quick actions, env files with git protection status, live links. */
export class HomeViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'envdrop.home';
  private view: vscode.WebviewView | undefined;
  private readonly subs: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly state: EnvState,
    private readonly store: RevokeStore,
  ) {
    this.subs.push(
      state.onDidChange(() => void this.post()),
      store.onDidChange(() => void this.post()),
      vscode.workspace.onDidChangeConfiguration(
        (e) => e.affectsConfiguration('envdrop') && void this.post(),
      ),
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = webviewOptions(this.context.extensionUri);
    view.webview.html = renderHtml(view.webview, this.context.extensionUri, 'home.js', {
      title: 'EnvDrop',
      bodyClass: 'side',
    });
    view.webview.onDidReceiveMessage((m) => void this.onMessage(m));
    view.onDidChangeVisibility(() => view.visible && void this.post());
  }

  private async post() {
    if (!this.view) return;
    const c = cfg();
    let host = c.serverUrl;
    try {
      host = new URL(c.serverUrl).host;
    } catch {
      /* keep raw */
    }
    const links = (await this.store.list()).map((l) => ({
      id: l.id,
      fileName: l.fileName,
      host: new URL(l.origin).host,
      expiresAt: l.expiresAt,
      createdAt: l.createdAt,
      maxViews: l.maxViews,
    }));
    await this.view.webview.postMessage({
      type: 'state',
      trusted: vscode.workspace.isTrusted,
      hasWorkspace: (vscode.workspace.workspaceFolders?.length ?? 0) > 0,
      files: this.state.files.map((f) => ({
        ...f,
        hasExample: Boolean(f.examplePath),
        examplePath: undefined,
      })),
      links,
      guard: { enabled: c.precommitEnabled, scanContent: c.precommitScanContent },
      server: host,
    });
  }

  private async onMessage(raw: unknown) {
    const m = (raw ?? {}) as Record<string, unknown>;
    // Only act on paths we told the webview about.
    const file = typeof m.path === 'string' ? this.state.find(m.path) : undefined;
    const uri = file ? vscode.Uri.file(file.path) : undefined;
    switch (m.type) {
      case 'ready':
      case 'refresh':
        await this.state.refresh();
        return this.post();
      case 'share':
        return void vscode.commands.executeCommand('envdrop.share', uri);
      case 'pull':
        return void vscode.commands.executeCommand('envdrop.pull');
      case 'fix':
        if (file) await ensureGitignored(file.path, 'fix');
        return this.state.refresh();
      case 'reveal':
        if (uri) await vscode.commands.executeCommand('revealInExplorer', uri);
        return;
      case 'checkKeys':
        return void vscode.commands.executeCommand('envdrop.checkKeys', uri);
      case 'genExample':
        return void vscode.commands.executeCommand('envdrop.generateExample', uri);
      case 'revoke': {
        const rec = (await this.store.list()).find((l) => l.id === m.id);
        if (!rec) return;
        try {
          const ok = await new ApiClient(rec.origin).revoke(rec.id, rec.revokeToken);
          void vscode.window.showInformationMessage(
            ok
              ? `EnvDrop: link to ${rec.fileName} revoked.`
              : 'EnvDrop: link had already expired or been used.',
          );
        } catch (e) {
          void vscode.window.showErrorMessage(
            `EnvDrop: revoke failed: ${e instanceof Error ? e.message : 'error'}`,
          );
          return;
        }
        return this.store.remove(rec.id);
      }
      case 'guard': {
        const key = m.key === 'scanContent' ? 'precommit.scanContent' : 'precommit.enabled';
        return vscode.workspace
          .getConfiguration('envdrop')
          .update(key, Boolean(m.value), vscode.ConfigurationTarget.Global);
      }
      case 'settings':
        return void vscode.commands.executeCommand(
          'workbench.action.openSettings',
          '@ext:your-publisher.envdrop',
        );
      case 'link': {
        if (m.to === 'threat') return void vscode.commands.executeCommand('envdrop.learnMore');
        const url = m.to === 'issues' ? ISSUES_URL : REPO_URL;
        return void vscode.env.openExternal(vscode.Uri.parse(url));
      }
    }
  }

  dispose() {
    this.subs.forEach((s) => s.dispose());
  }
}
