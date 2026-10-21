import { createMiddleware } from 'hono/factory';
import { timingSafeEqual } from '../core/crypto';
import { forbidden, rateLimited, unauthorized } from '../core/errors';
import { ipAllowed } from '../lib/ip';
import type { AppEnv } from '../app-types';
import { rateLimit } from './rate-limit';

/** Wrong keys from one address: after this many in a quarter of an hour it is locked out, even with the right key. */
const MAX_BAD_KEYS = 10;
const LOCKOUT_SECONDS = 900;

/** The outermost layer: writes down every call, including the ones the layers below turn away. */
const audit = createMiddleware<AppEnv>(async (c, next) => {
  await next();
  const d = c.get('deps');
  try {
    await d.adminAudit.record({
      actor: c.get('adminActor') ?? 'anonymous',
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res.status,
      ipHash: await d.hashIp(c.req.header('cf-connecting-ip') ?? 'unknown'),
      requestId: c.get('requestId'),
    });
  } catch (e) {
    // Losing an audit line must not turn an admin request into a failure, but it must not pass quietly either.
    c.get('logger').error('admin audit write failed', { message: String(e) });
  }
});

const fromAllowedAddress = createMiddleware<AppEnv>(async (c, next) => {
  const allowed = c.get('deps').config.ADMIN_ALLOWED_IPS;
  if (allowed.length > 0 && !ipAllowed(c.req.header('cf-connecting-ip') ?? '', allowed))
    throw forbidden('The admin API cannot be used from this address');
  await next();
});

/** If Cloudflare Access is set up, the request must have come through an Access login. */
const throughAccess = createMiddleware<AppEnv>(async (c, next) => {
  const verifier = c.get('deps').accessVerifier;
  if (verifier) c.set('adminActor', await verifier.verify(c.req.header('cf-access-jwt-assertion')));
  await next();
});

/** The shared admin key in `x-admin-key`. Wrong or missing is a plain 401 either way, and repeated misses lock the address out. */
const withAdminKey = createMiddleware<AppEnv>(async (c, next) => {
  const d = c.get('deps');
  const who = `admin-bad-key:${await d.hashIp(c.req.header('cf-connecting-ip') ?? 'unknown')}`;
  const locked = await d.strictLimiter.peek(who, MAX_BAD_KEYS, LOCKOUT_SECONDS);
  if (!locked.allowed) throw rateLimited(locked.retryAfterSeconds);
  const given = c.req.header('x-admin-key');
  if (!given || !timingSafeEqual(given, d.config.ADMIN_API_KEY)) {
    await d.strictLimiter.hit(who, MAX_BAD_KEYS, LOCKOUT_SECONDS);
    throw unauthorized('Admin key required');
  }
  if (!c.get('adminActor')) c.set('adminActor', 'api-key');
  await next();
});

export const requireAdmin = [
  rateLimit({ name: 'admin', limit: 120, windowSeconds: 60, strict: true }),
  audit,
  fromAllowedAddress,
  throughAccess,
  withAdminKey,
];
