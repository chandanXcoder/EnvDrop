import { promises as fs } from 'node:fs';
import { homedir } from 'node:os';
import * as path from 'node:path';

export interface CliLinkRecord {
  id: string;
  origin: string;
  revokeToken: string;
  expiresAt: number;
  fileName: string;
  createdAt: number;
  maxViews: number;
}

/** ~/.config/envdrop (or $XDG_CONFIG_HOME, %APPDATA%, $ENVDROP_HOME). */
export function configDir(env = process.env): string {
  if (env.ENVDROP_HOME) return env.ENVDROP_HOME;
  if (process.platform === 'win32' && env.APPDATA) return path.join(env.APPDATA, 'envdrop');
  return path.join(env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'envdrop');
}

/**
 * Revoke tokens for links created by this CLI, in a 0600 file. Never stores link keys.
 * (The VS Code extension uses the OS keychain instead; a CLI has no portable one.)
 */
export class LinkStore {
  private readonly file: string;
  constructor(dir = configDir()) {
    this.file = path.join(dir, 'links.json');
  }

  async list(now = Date.now()): Promise<CliLinkRecord[]> {
    let all: CliLinkRecord[];
    try {
      all = JSON.parse(await fs.readFile(this.file, 'utf8')) as CliLinkRecord[];
    } catch {
      all = [];
    }
    const live = all.filter((r) => r.expiresAt > now);
    if (live.length !== all.length) await this.save(live);
    return live.sort((a, b) => b.createdAt - a.createdAt);
  }

  async add(rec: CliLinkRecord): Promise<void> {
    const all = await this.list();
    all.unshift(rec);
    await this.save(all.slice(0, 200));
  }

  async remove(id: string): Promise<void> {
    await this.save((await this.list()).filter((r) => r.id !== id));
  }

  private async save(recs: CliLinkRecord[]) {
    await fs.mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    await fs.writeFile(this.file, JSON.stringify(recs, null, 2), { mode: 0o600 });
    await fs.chmod(this.file, 0o600).catch(() => undefined);
  }
}
