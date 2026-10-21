import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../../app-types';
import { authErrors, bearer, json, jsonBody, z } from '../../core/openapi';
import { requireAuth } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rate-limit';

export const accountRoutes = new OpenAPIHono<AppEnv>();

const CONFIRMATION = 'DELETE MY ACCOUNT';
const deleteBody = z
  .object({ confirm: z.literal(CONFIRMATION).describe(`Must be exactly "${CONFIRMATION}"`) })
  .openapi('DeleteAccountRequest');
const deleteResult = z
  .object({ deleted: z.literal(true), subscriptionNote: z.string().nullable() })
  .openapi('DeleteAccountResult');

accountRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/account/export',
    tags: ['Account'],
    summary: 'Download a copy of all your data (JSON)',
    security: bearer,
    description:
      'Everything held about the account: profile, diary, weight, water, custom foods, scan reports, workouts, subscriptions. Photos are not inside the file; each meal photo can be fetched on its own.',
    middleware: [requireAuth, rateLimit({ name: 'export', limit: 5, windowSeconds: 3600, by: 'user' })],
    responses: { 200: json(z.record(z.string(), z.unknown()), 'The data'), ...authErrors },
  }), // fmt: skip
  async (c) => {
    const data = await c.get('deps').account.export(c.get('auth')!.userId);
    return c.json(data, 200, { 'content-disposition': 'attachment; filename="my-data.json"' });
  },
);

accountRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/account',
    tags: ['Account'],
    summary: 'Permanently delete the account and all its data',
    security: bearer,
    description:
      'Erases the profile, diary, photos, workouts and everything else, and signs every device out. There is no undo. A store subscription must be cancelled in the store.',
    middleware: [
      requireAuth,
      rateLimit({ name: 'delete-account', limit: 5, windowSeconds: 3600, by: 'user' }),
    ],
    request: { body: jsonBody(deleteBody) },
    responses: { 200: json(deleteResult, 'Deleted'), ...authErrors },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').account.delete(c.get('auth')!.userId), 200),
);
