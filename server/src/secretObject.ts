import { DurableObject } from 'cloudflare:workers';
import { revokeMatches, takeTransition } from './secretLogic';
import type { SecretStore, StoredSecret, TakeResult } from './store';

const KEY = 'secret';

/**
 * One Durable Object per secret. A DO processes its requests one at a time, and its
 * input gates stop other events from interleaving with storage operations, so
 * get→decrement→put is atomic. An alarm deletes the record at expiry even if nobody
 * reads it.
 */
export class SecretObject extends DurableObject {
  async create(record: StoredSecret): Promise<boolean> {
    if (await this.ctx.storage.get(KEY)) return false;
    await this.ctx.storage.put(KEY, record);
    await this.ctx.storage.setAlarm(record.expiresAt);
    return true;
  }

  async take(now: number): Promise<TakeResult | undefined> {
    const { result, next } = takeTransition(await this.ctx.storage.get<StoredSecret>(KEY), now);
    if (next) await this.ctx.storage.put(KEY, next);
    else await this.wipe();
    return result;
  }

  async revoke(revokeHash: string, now: number): Promise<boolean> {
    const ok = revokeMatches(await this.ctx.storage.get<StoredSecret>(KEY), revokeHash, now);
    if (ok) await this.wipe();
    return ok;
  }

  override async alarm(): Promise<void> {
    await this.wipe();
  }

  private async wipe() {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
}

export class DurableObjectStore implements SecretStore {
  constructor(private readonly ns: DurableObjectNamespace<SecretObject>) {}
  private stub(id: string) {
    return this.ns.get(this.ns.idFromName(id));
  }
  create(id: string, record: StoredSecret) {
    return this.stub(id).create(record);
  }
  take(id: string, now: number) {
    return this.stub(id).take(now);
  }
  revoke(id: string, revokeHash: string, now: number) {
    return this.stub(id).revoke(revokeHash, now);
  }
}
