import * as vscode from 'vscode';
import type { EnvState } from './envState';

/** Explorer badges: 🔒 when gitignored, ! when it could be committed, !! when tracked. */
export class EnvDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private readonly sub: vscode.Disposable;

  constructor(private readonly state: EnvState) {
    this.sub = state.onDidChange(() => this.emitter.fire(undefined));
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== 'file') return undefined;
    const f = this.state.find(uri.fsPath);
    if (!f) return undefined;
    switch (f.ignore) {
      case 'ignored':
        return { badge: '🔒', tooltip: 'EnvDrop: protected by .gitignore' };
      case 'not-ignored':
        return {
          badge: '!',
          tooltip: 'EnvDrop: NOT covered by .gitignore, so it could be committed',
          color: new vscode.ThemeColor('list.warningForeground'),
        };
      case 'tracked':
        return {
          badge: '!!',
          tooltip: 'EnvDrop: tracked by git, so it will be committed',
          color: new vscode.ThemeColor('list.errorForeground'),
        };
      default:
        return undefined;
    }
  }

  dispose() {
    this.sub.dispose();
    this.emitter.dispose();
  }
}

/** Status bar item reflecting the workspace's env-file protection. */
export class GuardStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(
    'envdrop.status',
    vscode.StatusBarAlignment.Left,
    0,
  );
  private readonly sub: vscode.Disposable;

  constructor(private readonly state: EnvState) {
    this.item.name = 'EnvDrop';
    this.item.command = 'envdrop.home.focus';
    this.sub = state.onDidChange(() => this.render());
    this.render();
    this.item.show();
  }

  render() {
    const problems = this.state.problems;
    const total = this.state.files.length;
    const md = new vscode.MarkdownString(undefined, true);
    md.isTrusted = { enabledCommands: ['envdrop.share', 'envdrop.pull', 'envdrop.home.focus'] };
    md.appendMarkdown('**$(lock) EnvDrop**: end-to-end encrypted .env sharing\n\n');
    if (problems.length > 0) {
      this.item.text = `$(warning) EnvDrop ${problems.length}`;
      this.item.backgroundColor = new vscode.ThemeColor('statusBarItem.warningBackground');
      md.appendMarkdown(
        `$(warning) ${problems.length} env file(s) at risk of being committed:\n\n`,
      );
      for (const p of problems.slice(0, 6)) {
        md.appendMarkdown(
          `- \`${p.rel}\` (${p.ignore === 'tracked' ? 'tracked by git' : 'not gitignored'})\n`,
        );
      }
      md.appendMarkdown('\n[Open EnvDrop to fix](command:envdrop.home.focus)');
    } else {
      this.item.text = total > 0 ? `$(shield) EnvDrop` : `$(lock) EnvDrop`;
      this.item.backgroundColor = undefined;
      md.appendMarkdown(
        total > 0
          ? `$(pass) ${total} env file(s), all protected by .gitignore\n\n`
          : 'No env files in this workspace\n\n',
      );
      md.appendMarkdown(
        '[$(cloud-upload) Share](command:envdrop.share) · [$(cloud-download) Pull](command:envdrop.pull)',
      );
    }
    this.item.tooltip = md;
  }

  dispose() {
    this.sub.dispose();
    this.item.dispose();
  }
}
