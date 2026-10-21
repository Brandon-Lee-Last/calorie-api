import { createMiddleware } from 'hono/factory';
import { rateLimited } from '../core/errors';
import type { AppEnv } from '../app-types';

type Options = {
  name: string;
  limit: number;
  windowSeconds: number;
  by?: 'ip' | 'user';
  /** Count in the shared database instead of this instance's memory. Use for limits that must really hold. */
  strict?: boolean;
};

/**
 * Per-client brake. `by: 'user'` falls back to the IP when the request is not signed in. Strict limits store a hash of the
 * address (never the address itself).
 */
export const rateLimit = ({ name, limit, windowSeconds, by = 'ip', strict = false }: Options) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const deps = c.get('deps');
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    const who = by === 'user' ? (c.get('auth')?.userId ?? (await deps.hashIp(ip))) : await deps.hashIp(ip);
    const limiter = strict ? deps.strictLimiter : deps.rateLimiter;
    const decision = await limiter.hit(`${name}:${who}`, limit, windowSeconds);
    if (!decision.allowed) throw rateLimited(decision.retryAfterSeconds);
    await next();
  });
