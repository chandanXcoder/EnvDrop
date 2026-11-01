import { revokeMatches, takeTransition } from './secretLogic';
import { type SecretStore, StoreFullError, type StoredSecret, type TakeResult } from './store';

/**
 * In-process store for tests and single-instance self-hosting. JavaScript's single
 * thread makes each method atomic because none of them awaits midway.
 */
export class MemoryStore implements SecretStore {
  private readonly map = new Map<string, StoredSecret>();

  /** @param maxEntries cap to bound memory use (each entry is at most ~64 KB). */
  constructor(private readonly maxEntries = 10_000) {}

  async create(id: string, record: StoredSecret): Promise<boolean> {
    this.sweep(Date.now());
    if (this.map.has(id)) return false;
    if (this.map.size >= this.maxEntries) throw new StoreFullError();
    this.map.set(id, structuredClone(record));
    return true;
  }

  async take(id: string, now: number): Promise<TakeResult | undefined> {
    const { result, next } = takeTransition(this.map.get(id), now);
    if (next) this.map.set(id, next);
    else this.map.delete(id);
    return result;
  }

  async revoke(id: string, revokeHash: string, now: number): Promise<boolean> {
    const ok = revokeMatches(this.map.get(id), revokeHash, now);
    if (ok) this.map.delete(id);
    return ok;
  }

  /** Test helper: is anything stored under this id? */
  has(id: string): boolean {
    return this.map.has(id);
  }

  get size(): number {
    return this.map.size;
  }

  /** Deletes expired entries. Self-hosted servers call this on a timer. */
  sweep(now = Date.now()) {
    for (const [id, rec] of this.map) if (rec.expiresAt <= now) this.map.delete(id);
  }
}
