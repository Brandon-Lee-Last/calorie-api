import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../../app-types';
import { FEATURE_NAMES } from '../../config/features';
import { PLANS } from '../../config/plans';
import { commonErrors, json, jsonBody } from '../../core/openapi';
import { requireAdmin } from '../../middleware/admin';
import { publicConfigSchema, settingsPatchSchema, settingsSchema } from './settings.schemas';

export const settingsRoutes = new OpenAPIHono<AppEnv>();

settingsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/config',
    tags: ['Config'],
    summary: 'Everything the app needs to know before it starts',
    description:
      'Call on every launch, before anything else. It always answers, even in maintenance mode or for an app version that is too old. ' +
      'Send `x-app-version` (for example `1.4.0`) to learn whether an update is available or required.',
    responses: { 200: json(publicConfigSchema, 'The configuration'), ...commonErrors },
  }),
  async (c) => {
    const d = c.get('deps');
    const s = await d.settings.get();
    const cfg = d.config;
    c.header('cache-control', 'public, max-age=30');
    return c.json(
      {
        apiVersion: 'v1' as const,
        serverTime: d.clock.now(),
        maintenance: s.maintenance,
        update: d.settings.updateState(c.req.header('x-app-version'), s),
        minAppVersion: s.minAppVersion,
        latestAppVersion: s.latestAppVersion,
        features: Object.fromEntries(FEATURE_NAMES.map((f) => [f, !s.disabledFeatures.includes(f)])),
        signIn: {
          google: cfg.GOOGLE_CLIENT_IDS.length > 0,
          email: d.emailSignInAvailable && !s.disabledFeatures.includes('emailSignIn'),
        },
        integrity: { required: d.integrity.required },
        urls: {
          store: cfg.STORE_URL ?? null,
          privacy: cfg.PRIVACY_URL ?? null,
          terms: cfg.TERMS_URL ?? null,
          supportEmail: cfg.SUPPORT_EMAIL ?? null,
        },
        plans: Object.fromEntries(
          Object.values(PLANS).map((p) => [p.id, { limits: p.limits, features: p.features }]),
        ),
      },
      200,
    );
  },
);

const guarded = { security: [{ adminKey: [] }], middleware: requireAdmin };

settingsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/admin/settings',
    tags: ['Admin'],
    summary: 'The live switches: maintenance mode, app versions, disabled features',
    ...guarded,
    responses: { 200: json(settingsSchema, 'Current settings'), 401: commonErrors[400] },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').settings.get(), 200),
);

settingsRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/admin/settings',
    tags: ['Admin'],
    summary: 'Change the live switches',
    ...guarded,
    description:
      'Takes effect within seconds on every instance, with no deploy. Only the fields you send change; `null` removes an override so the ' +
      'deploy’s value applies again.',
    request: { body: jsonBody(settingsPatchSchema) },
    responses: { 200: json(settingsSchema, 'New settings'), 401: commonErrors[400], 422: commonErrors[422] },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').settings.update(c.req.valid('json')), 200),
);
