import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../../app-types';
import { notConfigured } from '../../core/errors';
import { authErrors, bearer, commonErrors, json, jsonBody } from '../../core/openapi';
import { requireAuth } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rate-limit';
import {
  entitlementSchema,
  simulateBodySchema,
  subscriptionStateSchema,
  verifyBodySchema,
} from './subscriptions.schemas';

export const subscriptionsRoutes = new OpenAPIHono<AppEnv>();
const secured = { security: bearer, middleware: [requireAuth] };
const uid = (c: { get(k: 'auth'): { userId: string } | undefined }) => c.get('auth')!.userId;

subscriptionsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/entitlements',
    tags: ['Subscription'],
    summary: 'What this person can use, and how much of today’s allowance is left',
    ...secured,
    description:
      'Plan, limits and today’s usage in one call. Check it on app start and after any purchase. Photo scans run on the phone, so `scansPerDay` is for the app to enforce; the server counts scans and reports them here.',
    responses: { 200: json(entitlementSchema, 'The entitlement'), ...authErrors },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').subscriptions.summary(uid(c)), 200),
);

subscriptionsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/subscription',
    tags: ['Subscription'],
    summary: 'Current subscription, entitlement and the products on sale',
    ...secured,
    responses: { 200: json(subscriptionStateSchema, 'The state'), ...authErrors },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').subscriptions.current(uid(c)), 200),
);

subscriptionsRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/subscription/verify',
    tags: ['Subscription'],
    summary: 'Tell the server about a purchase the app just made',
    ...secured,
    description:
      'The server asks the store whether the purchase is real, then attaches it to this account. Idempotent: repeating it is harmless. 409 if the purchase already belongs to another account.',
    middleware: [requireAuth, rateLimit({ name: 'verify', limit: 30, windowSeconds: 3600, by: 'user' })],
    request: { body: jsonBody(verifyBodySchema) },
    responses: {
      200: json(subscriptionStateSchema, 'The updated state'),
      409: commonErrors[400],
      501: commonErrors[400],
      ...authErrors,
    },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').subscriptions.verify(uid(c), c.req.valid('json')), 200),
);

subscriptionsRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/subscription/restore',
    tags: ['Subscription'],
    summary: 'Restore purchases: re-read this account’s subscriptions from the store',
    ...secured,
    middleware: [requireAuth, rateLimit({ name: 'restore', limit: 30, windowSeconds: 3600, by: 'user' })],
    responses: {
      200: json(subscriptionStateSchema, 'The refreshed state'),
      501: commonErrors[400],
      ...authErrors,
    },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').subscriptions.restore(uid(c)), 200),
);

subscriptionsRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/subscription/simulate',
    tags: ['Subscription'],
    summary: 'Development and stage only: move the pretend subscription through its life',
    ...secured,
    description:
      'Answers 404 where simulation is off (always in production). `subscribe` starts a pretend subscription; the others change the latest one: `renew`, `cancel`, `expire`, `grace` (payment failed), `hold`, `refund`.',
    request: { body: jsonBody(simulateBodySchema) },
    responses: {
      200: json(subscriptionStateSchema, 'The updated state'),
      404: commonErrors[400],
      ...authErrors,
    },
  }), // fmt: skip
  async (c) => {
    const { scenario, productId } = c.req.valid('json');
    return c.json(await c.get('deps').subscriptions.simulate(uid(c), scenario, productId), 200);
  },
);

// The store calls this when a subscription changes (renewal, cancellation, payment failure). Wired up when the Play account exists.
subscriptionsRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/webhooks/google-play',
    tags: ['Subscription'],
    summary: 'Google Play real-time developer notifications (not enabled yet)',
    responses: {
      204: { description: 'Processed (what the store expects once this is enabled)' },
      501: commonErrors[400],
    },
  }), // fmt: skip
  () => {
    throw notConfigured('Google Play notifications');
  },
);
