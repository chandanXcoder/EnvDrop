import type { Envelope } from '@envdrop/shared';

export interface StoredSecret {
  envelope: Envelope;
  viewsLeft: number;
  /** epoch ms */
  expiresAt: number;
  /** base64url SHA-256 of the revoke token */
  revokeHash: string;
}

export interface TakeResult {
  envelope: Envelope;
  viewsLeft: number;
  expiresAt: number;
}

/**
 * Storage backend. Implementations MUST make `take` atomic: two concurrent reads of a
 * 1-view secret must never both succeed.
 */
export interface SecretStore {
  /** Returns false if the id already exists. */
  create(id: string, record: StoredSecret): Promise<boolean>;
  /** Consumes one view. Deletes the record when views reach 0 or it has expired. */
  take(id: string, now: number): Promise<TakeResult | undefined>;
  /** Deletes the record if the revoke hash matches (constant-time). */
  revoke(id: string, revokeHash: string, now: number): Promise<boolean>;
}
