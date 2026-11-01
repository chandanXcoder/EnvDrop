import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { addEmptyKeys, checkKeys, generateExample } from '@envdrop/shared';
import * as vscode from 'vscode';
import { renderHtml, webviewOptions } from './webview';

/** Phase 2: compare a .env with its .env.example. Shows key names only. */
export async function showKeysPanel(
  context: vscode.ExtensionContext,
  envPath: string,
  examplePath: string,
): Promise<void> {
  const panel = vscode.window.createWebviewPanel(
    'envdrop.keys',
    `EnvDrop: keys in ${path.basename(envPath)}`,
    vscode.ViewColumn.Active,
    webviewOptions(context.extensionUri),
  );
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
  panel.webview.html = renderHtml(panel.webview, context.extensionUri, 'keys.js', {
    title: 'Keys',
  });

  const post = async (flash?: string) => {
    const [env, ex] = await Promise.all([
      fs.readFile(envPath, 'utf8'),
      fs.readFile(examplePath, 'utf8'),
    ]);
    await panel.webview.postMessage({
      type: 'state',
      envName: vscode.workspace.asRelativePath(envPath, true),
      exampleName: vscode.workspace.asRelativePath(examplePath, true),
      result: checkKeys(env, ex),
      flash,
    });
  };

  panel.webview.onDidReceiveMessage(async (raw: unknown) => {
    const m = (raw ?? {}) as Record<string, unknown>;
    try {
      const env = await fs.readFile(envPath, 'utf8');
      const ex = await fs.readFile(examplePath, 'utf8');
      const r = checkKeys(env, ex);
      switch (m.type) {
        case 'ready':
          return post();
        case 'addMissing':
          await fs.writeFile(envPath, addEmptyKeys(env, r.missing), 'utf8');
          return post(
            `Added ${r.missing.length} empty key(s) to ${path.basename(envPath)}. Fill in their values.`,
          );
        case 'addExtra':
          await fs.writeFile(examplePath, addEmptyKeys(ex, r.extra), 'utf8');
          return post(`Documented ${r.extra.length} key(s) in ${path.basename(examplePath)}.`);
        case 'regenerate':
          await fs.writeFile(examplePath, generateExample(env, ex), 'utf8');
          return post(
            `Regenerated ${path.basename(examplePath)} from ${path.basename(envPath)} (values stripped).`,
          );
        case 'openEnv':
          return void vscode.window.showTextDocument(vscode.Uri.file(envPath));
        case 'openExample':
          return void vscode.window.showTextDocument(vscode.Uri.file(examplePath));
        case 'refresh':
          return post();
      }
    } catch (e) {
      void vscode.window.showErrorMessage(`EnvDrop: ${e instanceof Error ? e.message : 'failed'}`);
    }
  });
}
