import { fromBase64Url, timingSafeEqual } from '@envdrop/shared';
import type { StoredSecret, TakeResult } from './store';

/**
 * Pure state transitions shared by every store implementation, so the burn/expiry
 * semantics are identical in tests, Durable Objects and self-hosted mode.
 */
export function takeTransition(
  rec: StoredSecret | undefined,
  now: number,
): { result?: TakeResult; next: StoredSecret | null } {
  if (!rec || rec.expiresAt <= now || rec.viewsLeft <= 0) return { next: null };
  const viewsLeft = rec.viewsLeft - 1;
  return {
    result: { envelope: rec.envelope, viewsLeft, expiresAt: rec.expiresAt },
    next: viewsLeft > 0 ? { ...rec, viewsLeft } : null,
  };
}

export function revokeMatches(
  rec: StoredSecret | undefined,
  revokeHash: string,
  now: number,
): boolean {
  if (!rec || rec.expiresAt <= now) return false;
  try {
    return timingSafeEqual(fromBase64Url(rec.revokeHash), fromBase64Url(revokeHash));
  } catch {
    return false;
  }
}
