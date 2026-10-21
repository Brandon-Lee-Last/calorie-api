import { createMiddleware } from 'hono/factory';
import { maintenance, upgradeRequired } from '../core/errors';
import type { AppEnv } from '../app-types';

/** Paths that keep working in maintenance mode and for old app versions: the app needs them to find out what is going on. */
const OPEN = [
  /^\/v1\/health/,
  /^\/v1\/config$/,
  /^\/v1\/openapi\.json$/,
  /^\/v1\/admin\//,
  /^\/v1\/webhooks\//,
];

/**
 * The switch in front of the whole API.
 *  - Maintenance mode answers 503 `maintenance` (with Retry-After) to everything except the paths above.
 *  - An app that sends `x-app-version` older than the minimum answers 426 `upgrade_required`. No header, or one that is not a
 *    version, is let through: this protects people from broken old releases, it is not a lock.
 */
export const gate = createMiddleware<AppEnv>(async (c, next) => {
  const path = new URL(c.req.url).pathname;
  if (OPEN.some((re) => re.test(path))) return next();
  const d = c.get('deps');
  const settings = await d.settings.get();
  if (settings.maintenance.enabled) throw maintenance(settings.maintenance.message);
  if (d.settings.updateState(c.req.header('x-app-version'), settings) === 'required')
    throw upgradeRequired({ minAppVersion: settings.minAppVersion, storeUrl: d.config.STORE_URL ?? null });
  return next();
});
