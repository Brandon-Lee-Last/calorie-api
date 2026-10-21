import { createMiddleware } from 'hono/factory';
import { timingSafeEqual } from '../core/crypto';
import { unauthorized } from '../core/errors';
import type { AppEnv } from '../app-types';
import { rateLimit } from './rate-limit';

/** Admin endpoints take the shared admin key in `x-admin-key`. Wrong or missing is a plain 401 either way. */
const check = createMiddleware<AppEnv>(async (c, next) => {
  const given = c.req.header('x-admin-key');
  if (!given || !timingSafeEqual(given, c.get('deps').config.ADMIN_API_KEY))
    throw unauthorized('Admin key required');
  await next();
});

export const requireAdmin = [rateLimit({ name: 'admin', limit: 300, windowSeconds: 60 }), check];
