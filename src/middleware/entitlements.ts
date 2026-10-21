import { createMiddleware } from 'hono/factory';
import { subscriptionRequired, unauthorized } from '../core/errors';
import type { AppEnv } from '../app-types';

/** Only Pro accounts get through. Use after `requireAuth`. The name is for the error the app shows. */
export const requirePro = (feature: string) =>
  createMiddleware<AppEnv>(async (c, next) => {
    const auth = c.get('auth');
    if (!auth) throw unauthorized();
    if ((await c.get('deps').subscriptions.entitlement(auth.userId)).plan !== 'pro')
      throw subscriptionRequired(feature);
    await next();
  });
