import * as vscode from 'vscode';

export const REPO_URL = 'https://github.com/chandanXcoder/EnvDrop';
export const ISSUES_URL = `${REPO_URL}/issues`;

export function nonce(): string {
  const b = new Uint8Array(18);
  crypto.getRandomValues(b);
  return Buffer.from(b).toString('base64url');
}

export function mediaRoot(extensionUri: vscode.Uri): vscode.Uri {
  return vscode.Uri.joinPath(extensionUri, 'media');
}

/**
 * Builds a webview document with a strict CSP: no inline script or style, no remote
 * resources. Only our own media/ files (scripts additionally need the per-load nonce).
 */
export function renderHtml(
  webview: vscode.Webview,
  extensionUri: vscode.Uri,
  script: string,
  opts: { title: string; bodyClass?: string },
): string {
  const n = nonce();
  const m = mediaRoot(extensionUri);
  const uri = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(m, ...p)).toString();
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource}`,
    `font-src ${webview.cspSource}`,
    `img-src ${webview.cspSource} data:`,
    `script-src 'nonce-${n}'`,
  ].join('; ');
  const esc = (s: string) => s.replace(/[&<>"]/g, (c) => `&#${c.charCodeAt(0)};`);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(opts.title)}</title>
<link rel="stylesheet" href="${uri('codicons', 'codicon.css')}">
<link rel="stylesheet" href="${uri('base.css')}">
</head><body class="${esc(opts.bodyClass ?? 'panel')}">
<div id="app" aria-live="polite"></div>
<script nonce="${n}" src="${uri('ui.js')}"></script>
<script nonce="${n}" src="${uri(script)}"></script>
</body></html>`;
}

export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return { enableScripts: true, localResourceRoots: [mediaRoot(extensionUri)] };
}
