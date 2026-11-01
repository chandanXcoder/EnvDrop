import { diffEnv, type EnvDiff, maskValue, parseEnv } from '@envdrop/shared';
import * as vscode from 'vscode';
import { renderHtml, webviewOptions } from './webview';

export type ReviewResult =
  | { mode: 'merge'; apply: string[]; remove: string[]; backup: boolean }
  | { mode: 'replace'; backup: boolean };

export interface ReviewOptions {
  targetName: string;
  /** undefined when the target file doesn't exist yet */
  localText?: string;
  incomingText: string;
  origin: string;
  viewsLeft: number;
}

type Row = { key: string; status: 'added' | 'removed' | 'changed' | 'unchanged' };

function rowsFrom(d: EnvDiff): Row[] {
  return [
    ...d.added.map((key) => ({ key, status: 'added' as const })),
    ...d.changed.map((key) => ({ key, status: 'changed' as const })),
    ...d.removed.map((key) => ({ key, status: 'removed' as const })),
    ...d.unchanged.map((key) => ({ key, status: 'unchanged' as const })),
  ];
}

/**
 * Masked, key-level review of an incoming env file.
 *
 * The webview only receives key names and statuses. A value is sent on an explicit
 * "Reveal" click, one at a time, and the webview clears it after 10 seconds.
 */
export function showEnvReview(
  context: vscode.ExtensionContext,
  opts: ReviewOptions,
): Promise<ReviewResult | undefined> {
  const incoming = parseEnv(opts.incomingText);
  const local = opts.localText !== undefined ? parseEnv(opts.localText) : undefined;
  const diff = diffEnv(local ?? parseEnv(''), incoming);

  const panel = vscode.window.createWebviewPanel(
    'envdrop.review',
    `EnvDrop: review ${opts.targetName}`,
    vscode.ViewColumn.Active,
    { ...webviewOptions(context.extensionUri), retainContextWhenHidden: false },
  );
  panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'icon.png');
  panel.webview.html = renderHtml(panel.webview, context.extensionUri, 'review.js', {
    title: 'Review',
  });

  return new Promise((resolve) => {
    let settled = false;
    const finish = (r: ReviewResult | undefined) => {
      if (settled) return;
      settled = true;
      resolve(r);
      panel.dispose();
    };
    panel.onDidDispose(() => finish(undefined));
    panel.webview.onDidReceiveMessage((msg: unknown) => {
      const m = msg as Record<string, unknown>;
      switch (m?.type) {
        case 'ready':
          void panel.webview.postMessage({
            type: 'init',
            targetName: opts.targetName,
            isNew: local === undefined,
            origin: opts.origin,
            viewsLeft: opts.viewsLeft,
            mask: maskValue(),
            rows: rowsFrom(diff),
            parseWarnings: incoming.errors.length,
          });
          break;
        case 'reveal': {
          const key = String(m.key);
          const side = m.side === 'local' ? local : incoming;
          const entry = side?.entries.get(key);
          if (entry) {
            void panel.webview.postMessage({
              type: 'revealed',
              key,
              side: m.side,
              value: entry.value,
            });
          }
          break;
        }
        case 'apply': {
          const backup = m.backup !== false;
          if (m.mode === 'replace') return finish({ mode: 'replace', backup });
          const known = new Set([...incoming.entries.keys(), ...(local?.entries.keys() ?? [])]);
          const list = (v: unknown) =>
            Array.isArray(v) ? v.map(String).filter((k) => known.has(k)) : [];
          return finish({ mode: 'merge', apply: list(m.apply), remove: list(m.remove), backup });
        }
        case 'cancel':
          return finish(undefined);
      }
    });
  });
}
