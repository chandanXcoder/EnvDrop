import type * as vscode from 'vscode';

/** What we remember about links created on this machine. Never the decryption key. */
export interface SharedLinkRecord {
  id: string;
  origin: string;
  revokeToken: string;
  expiresAt: number;
  fileName: string;
  createdAt: number;
  maxViews: number;
}

const KEY = 'envdrop.sharedLinks.v1';

/** Stored in VS Code SecretStorage (OS keychain), not in settings or globalState. */
export class RevokeStore {
  constructor(private readonly secrets: vscode.SecretStorage) {}

  async list(now = Date.now()): Promise<SharedLinkRecord[]> {
    const raw = await this.secrets.get(KEY);
    let all: SharedLinkRecord[];
    try {
      all = raw ? (JSON.parse(raw) as SharedLinkRecord[]) : [];
    } catch {
      all = [];
    }
    const live = all.filter((r) => r.expiresAt > now);
    if (live.length !== all.length) await this.save(live);
    return live.sort((a, b) => b.createdAt - a.createdAt);
  }

  async add(rec: SharedLinkRecord): Promise<void> {
    const all = await this.list();
    all.unshift(rec);
    await this.save(all.slice(0, 200));
  }

  async remove(id: string): Promise<void> {
    await this.save((await this.list()).filter((r) => r.id !== id));
  }

  private save(recs: SharedLinkRecord[]): Thenable<void> {
    return this.secrets.store(KEY, JSON.stringify(recs));
  }
}
