export type RateBucket = 'create' | 'read' | 'revoke';

export interface RateLimiter {
  /** Returns true if the request is allowed. */
  allow(bucket: RateBucket, clientKey: string): Promise<boolean>;
}

export const DEFAULT_LIMITS: Record<RateBucket, { limit: number; windowMs: number }> = {
  create: { limit: 20, windowMs: 60_000 },
  read: { limit: 60, windowMs: 60_000 },
  revoke: { limit: 20, windowMs: 60_000 },
};

/** Fixed-window limiter for tests and single-instance self-hosting. */
export class MemoryRateLimiter implements RateLimiter {
  private readonly hits = new Map<string, { count: number; resetAt: number }>();
  constructor(
    private readonly limits = DEFAULT_LIMITS,
    private readonly now: () => number = Date.now,
  ) {}

  async allow(bucket: RateBucket, clientKey: string): Promise<boolean> {
    const { limit, windowMs } = this.limits[bucket];
    const k = `${bucket}:${clientKey}`;
    const t = this.now();
    const cur = this.hits.get(k);
    if (!cur || cur.resetAt <= t) {
      if (this.hits.size > 50_000) this.hits.clear(); // crude memory bound
      this.hits.set(k, { count: 1, resetAt: t + windowMs });
      return true;
    }
    cur.count++;
    return cur.count <= limit;
  }
}

/** Minimal shape of the Cloudflare Workers Rate Limiting binding. */
export interface CfRateLimitBinding {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export class CloudflareRateLimiter implements RateLimiter {
  constructor(private readonly bindings: Partial<Record<RateBucket, CfRateLimitBinding>>) {}
  async allow(bucket: RateBucket, clientKey: string): Promise<boolean> {
    const b = this.bindings[bucket];
    if (!b) return true;
    const { success } = await b.limit({ key: clientKey });
    return success;
  }
}
