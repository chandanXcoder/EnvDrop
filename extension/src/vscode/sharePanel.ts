import { ApiClient, qrMatrix } from '@envdrop/core';
import * as vscode from 'vscode';
import type { RevokeStore } from './revokeStore';
import { renderHtml, webviewOptions } from './webview';

export interface ShareSuccess {
  link: string;
  id: string;
  origin: string;
  revokeToken: string;
  fileName: string;
  keyCount: number;
  expiresAt: number;
  createdAt: number;
  maxViews: number;
  passphrase: boolean;
}

/**
 * Success screen after sharing. The full link (which contains the key) stays in the
 * extension host. The webview gets a masked version, plus a QR matrix only on request.
 */
export function showSharePanel(
  context: vscode.ExtensionContext,
  store: RevokeStore,
  s: ShareSuccess,
): void {
  const panel = vscode.window.createWebviewPanel(
    'envdrop.share',
    `EnvDrop: ${s.fileName} shared`,
    vscode.ViewColumn.Active,
    {
      ...webviewOptions(context.extensionUri),
      retainContextWhenHidden: true,
    },
  );
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
  panel.webview.html = renderHtml(panel.webview, context.extensionUri, 'share.js', {
    title: 'Shared',
  });
  const url = new URL(s.link);
  let link: string | undefined = s.link;
  panel.onDidDispose(() => (link = undefined));

  panel.webview.onDidReceiveMessage(async (raw: unknown) => {
    const m = (raw ?? {}) as Record<string, unknown>;
    switch (m.type) {
      case 'ready':
        return void panel.webview.postMessage({
          type: 'init',
          fileName: s.fileName,
          keyCount: s.keyCount,
          expiresAt: s.expiresAt,
          createdAt: s.createdAt,
          maxViews: s.maxViews,
          passphrase: s.passphrase,
          masked: `${url.host}/s/${s.id}#${'•'.repeat(10)}`,
        });
      case 'copy':
        if (!link) return;
        await vscode.env.clipboard.writeText(link);
        return void panel.webview.postMessage({ type: 'copied' });
      case 'clearClipboard':
        await vscode.env.clipboard.writeText('');
        return void panel.webview.postMessage({ type: 'cleared' });
      case 'qr':
        if (!link) return;
        return void panel.webview.postMessage({ type: 'qr', matrix: qrMatrix(link) });
      case 'revoke':
        try {
          const ok = await new ApiClient(s.origin).revoke(s.id, s.revokeToken);
          await store.remove(s.id);
          link = undefined;
          return void panel.webview.postMessage({ type: 'revoked', ok });
        } catch (e) {
          void vscode.window.showErrorMessage(
            `EnvDrop: revoke failed: ${e instanceof Error ? e.message : 'error'}`,
          );
          return;
        }
      case 'close':
        return panel.dispose();
    }
  });
}
