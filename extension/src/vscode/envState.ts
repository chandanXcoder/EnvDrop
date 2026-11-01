import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { isShareableEnvFile, type IgnoreStatus } from '@envdrop/core';
import { parseEnv } from '@envdrop/shared';
import * as vscode from 'vscode';
import { ignoreCheck } from './gitGuard';

export type EnvKind =
  'base' | 'local' | 'development' | 'staging' | 'production' | 'test' | 'other';

export interface EnvFileInfo {
  path: string;
  rel: string;
  name: string;
  env: EnvKind;
  keyCount: number;
  ignore: IgnoreStatus;
  examplePath?: string;
}

export function envKind(fileName: string): EnvKind {
  const n = fileName.toLowerCase();
  if (n === '.env') return 'base';
  if (/(^|\.)(prod|production)(\.|$)/.test(n)) return 'production';
  if (/(^|\.)(stag|stage|staging)(\.|$)/.test(n)) return 'staging';
  if (/(^|\.)(dev|development)(\.|$)/.test(n)) return 'development';
  if (/(^|\.)test(\.|$)/.test(n)) return 'test';
  if (/(^|\.)local(\.|$)/.test(n)) return 'local';
  return 'other';
}

const EXAMPLE_NAMES = ['.env.example', '.env.sample', '.env.template'];

async function exists(p: string): Promise<boolean> {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export async function findExample(envPath: string): Promise<string | undefined> {
  for (const n of EXAMPLE_NAMES) {
    const p = path.join(path.dirname(envPath), n);
    if (await exists(p)) return p;
  }
  return undefined;
}

/**
 * Single source of truth for env files in the workspace and their git protection
 * status. Feeds the sidebar, explorer badges and status bar. Holds key counts only,
 * never values.
 */
export class EnvState implements vscode.Disposable {
  private _files: EnvFileInfo[] = [];
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [];
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;

  constructor() {
    const w1 = vscode.workspace.createFileSystemWatcher('**/{.env,.env.*,*.env}');
    const w2 = vscode.workspace.createFileSystemWatcher('**/.gitignore');
    for (const w of [w1, w2]) {
      this.disposables.push(
        w,
        w.onDidCreate(() => this.schedule()),
        w.onDidDelete(() => this.schedule()),
        w.onDidChange(() => this.schedule()),
      );
    }
    this.disposables.push(vscode.workspace.onDidChangeWorkspaceFolders(() => this.schedule()));
  }

  get files(): readonly EnvFileInfo[] {
    return this._files;
  }

  get problems(): EnvFileInfo[] {
    return this._files.filter((f) => f.ignore === 'not-ignored' || f.ignore === 'tracked');
  }

  find(p: string): EnvFileInfo | undefined {
    return this._files.find((f) => f.path === p);
  }

  schedule(delay = 400) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.refresh(), delay);
  }

  refresh(): Promise<void> {
    this.running ??= this.doRefresh().finally(() => (this.running = undefined));
    return this.running;
  }

  private async doRefresh() {
    const uris = await vscode.workspace.findFiles(
      '**/{.env,.env.*,*.env}',
      '**/{node_modules,.git,dist,out,build,vendor}/**',
      200,
    );
    const infos = await Promise.all(
      uris
        .filter((u) => u.scheme === 'file' && isShareableEnvFile(u.fsPath))
        .map(async (u): Promise<EnvFileInfo | undefined> => {
          try {
            const text = await fs.readFile(u.fsPath, 'utf8');
            const check = await ignoreCheck(u.fsPath);
            return {
              path: u.fsPath,
              rel: vscode.workspace.asRelativePath(u, true),
              name: path.basename(u.fsPath),
              env: envKind(path.basename(u.fsPath)),
              keyCount: parseEnv(text).entries.size,
              ignore: check.status,
              examplePath: await findExample(u.fsPath),
            };
          } catch {
            return undefined;
          }
        }),
    );
    const order: EnvKind[] = [
      'base',
      'local',
      'development',
      'staging',
      'production',
      'test',
      'other',
    ];
    this._files = infos
      .filter((i): i is EnvFileInfo => i !== undefined)
      .sort(
        (a, b) =>
          a.rel.split('/').length - b.rel.split('/').length ||
          order.indexOf(a.env) - order.indexOf(b.env) ||
          a.rel.localeCompare(b.rel),
      );
    this.emitter.fire();
  }

  dispose() {
    if (this.timer) clearTimeout(this.timer);
    this.emitter.dispose();
    this.disposables.forEach((d) => d.dispose());
  }
}
