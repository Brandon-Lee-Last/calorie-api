import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../../app-types';
import { authErrors, bearer, commonErrors, json, jsonBody, z } from '../../core/openapi';
import { optionalAuth, requireAuth } from '../../middleware/auth';
import { requireIntegrity } from '../../middleware/integrity';
import { rateLimit } from '../../middleware/rate-limit';
import { issueChallenge } from '../integrity/integrity';
import {
  anonymousBodySchema,
  googleBodySchema,
  googleSessionSchema,
  refreshBodySchema,
  sessionSchema,
} from './auth.schemas';

export const authRoutes = new OpenAPIHono<AppEnv>();

authRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/auth/challenge',
    tags: ['Auth'],
    summary: 'A one-time challenge to pass to Play Integrity',
    description:
      'Where device checks are on (`required: true`), ask for a challenge, hand it to the Play Integrity API as the nonce, ' +
      'and send the token it returns with account creation: `x-integrity-token` and `x-integrity-challenge`. ' +
      'Challenges expire after five minutes.',
    middleware: [
      rateLimit({ name: 'auth-challenge', limit: 60, windowSeconds: 3600, strict: true }),
    ] as const,
    responses: {
      200: json(
        z
          .object({ challenge: z.string(), expiresAt: z.number().int(), required: z.boolean() })
          .openapi('Challenge'),
        'A challenge',
      ),
      ...commonErrors,
    },
  }),
  async (c) => {
    const d = c.get('deps');
    return c.json(
      { ...(await issueChallenge(d.config.JWT_SECRET, d.clock)), required: d.integrity.required },
      200,
    );
  },
);

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/auth/anonymous',
    tags: ['Auth'],
    summary: 'Start using the app without signing in',
    description:
      'Creates an anonymous account on this device. Link Google later with `POST /auth/google` to keep the data.',
    middleware: [
      rateLimit({ name: 'auth-anon-hour', limit: 10, windowSeconds: 3600, strict: true }),
      rateLimit({ name: 'auth-anon-day', limit: 30, windowSeconds: 86400, strict: true }),
      requireIntegrity,
    ] as const,
    request: { body: jsonBody(anonymousBodySchema) },
    responses: { 201: json(sessionSchema, 'Account created'), ...commonErrors },
  }),
  async (c) => {
    const { deviceLabel } = c.req.valid('json');
    return c.json(await c.get('deps').auth.registerAnonymous(deviceLabel ?? null), 201);
  },
);

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/auth/google',
    tags: ['Auth'],
    summary: 'Sign in with Google, or link Google to the signed-in anonymous account',
    description:
      'With a Bearer token for an anonymous account, the Google account is linked to it and the data is kept. ' +
      'If that Google account already has data, the call fails with 409 `identity_in_use` unless `discardAnonymousData` is true.',
    middleware: [
      rateLimit({ name: 'auth-google', limit: 60, windowSeconds: 3600, strict: true }),
      optionalAuth,
    ] as const,
    request: { body: jsonBody(googleBodySchema) },
    responses: {
      200: json(googleSessionSchema, 'Signed in'),
      ...authErrors,
      409: commonErrors[400],
      501: commonErrors[400],
    },
  }),
  async (c) => {
    const body = c.req.valid('json');
    const result = await c.get('deps').auth.signInWithGoogle({
      idToken: body.idToken,
      currentUserId: c.get('auth')?.userId ?? null,
      discardAnonymousData: body.discardAnonymousData,
      deviceLabel: body.deviceLabel ?? null,
    });
    return c.json(result, 200);
  },
);

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/auth/refresh',
    tags: ['Auth'],
    summary: 'Swap a refresh token for a new access token and a new refresh token',
    middleware: [rateLimit({ name: 'auth-refresh', limit: 600, windowSeconds: 3600 })] as const,
    request: { body: jsonBody(refreshBodySchema) },
    responses: { 200: json(sessionSchema, 'New tokens'), ...authErrors },
  }),
  async (c) => c.json(await c.get('deps').auth.refresh(c.req.valid('json').refreshToken), 200),
);

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/auth/logout',
    tags: ['Auth'],
    summary: 'End this device’s session',
    request: { body: jsonBody(refreshBodySchema) },
    responses: { 204: { description: 'Signed out (also returned for an unknown token)' }, ...commonErrors },
  }),
  async (c) => {
    await c.get('deps').auth.logout(c.req.valid('json').refreshToken);
    return c.body(null, 204);
  },
);

authRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/auth/logout-all',
    tags: ['Auth'],
    summary: 'End every session of this account',
    security: bearer,
    middleware: [requireAuth] as const,
    responses: { 204: { description: 'All refresh tokens revoked' }, ...authErrors },
  }),
  async (c) => {
    await c.get('deps').auth.logoutAll(c.get('auth')!.userId);
    return c.body(null, 204);
  },
);

export { z };
