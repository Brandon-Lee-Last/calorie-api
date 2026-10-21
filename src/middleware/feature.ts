import { createMiddleware } from 'hono/factory';
import { FEATURES, type FeatureName } from '../config/features';
import { featureDisabled } from '../core/errors';
import type { AppEnv } from '../app-types';

/** 503 `feature_disabled` while an admin has switched this feature off (a kill switch for a misbehaving or costly feature). */
export const requireFeature = (name: FeatureName) =>
  createMiddleware<AppEnv>(async (c, next) => {
    if (!(await c.get('deps').settings.isEnabled(name))) throw featureDisabled(name, FEATURES[name].describe);
    await next();
  });
