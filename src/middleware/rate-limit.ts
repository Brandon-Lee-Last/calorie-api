import { createMiddleware } from 'hono/factory';
import { rateLimited } from '../core/errors';
import type { AppEnv } from '../app-types';

type Options = { name: string; limit: number; windowSeconds: number; by?: 'ip' | 'user' };

/** Per-client brake. `by: 'user'` falls back to the IP when the request is not signed in. */
export const rateLimit = ({ name, limit, windowSeconds, by = 'ip' }: Options) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const ip = c.req.header('cf-connecting-ip') ?? 'unknown';
    const who = by === 'user' ? (c.get('auth')?.userId ?? ip) : ip;
    const decision = await c.get('deps').rateLimiter.hit(`${name}:${who}`, limit, windowSeconds);
    if (!decision.allowed) throw rateLimited(decision.retryAfterSeconds);
    await next();
  });
