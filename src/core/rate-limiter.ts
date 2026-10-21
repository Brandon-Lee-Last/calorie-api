import type { Clock } from './time';

export type RateDecision = { allowed: boolean; retryAfterSeconds: number };

export interface RateLimiter {
  hit(key: string, limit: number, windowSeconds: number): Promise<RateDecision>;
}

/**
 * Fixed-window counter held in the isolate's memory. It is a best-effort brake on bursts from one client, not a
 * guarantee: each isolate counts separately and a restart forgets. Hard limits belong in Cloudflare's WAF rate
 * limiting rules at the edge (see docs/operations.md) and in per-user D1 quotas for anything that costs money.
 */
export class MemoryRateLimiter implements RateLimiter {
  private windows = new Map<string, { start: number; count: number }>();

  constructor(
    private clock: Clock,
    private maxKeys = 5000,
  ) {}

  async hit(key: string, limit: number, windowSeconds: number): Promise<RateDecision> {
    const now = this.clock.now();
    const windowMs = windowSeconds * 1000;
    const w = this.windows.get(key);
    if (!w || now - w.start >= windowMs) {
      if (this.windows.size >= this.maxKeys) this.sweep(now, windowMs);
      this.windows.set(key, { start: now, count: 1 });
      return { allowed: true, retryAfterSeconds: 0 };
    }
    w.count += 1;
    if (w.count > limit)
      return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((w.start + windowMs - now) / 1000)) };
    return { allowed: true, retryAfterSeconds: 0 };
  }

  private sweep(now: number, windowMs: number) {
    for (const [k, w] of this.windows) if (now - w.start >= windowMs) this.windows.delete(k);
    if (this.windows.size >= this.maxKeys) this.windows.clear();
  }
}

/** Never limits. For tests that are not about limiting. */
export const unlimited: RateLimiter = { hit: async () => ({ allowed: true, retryAfterSeconds: 0 }) };
