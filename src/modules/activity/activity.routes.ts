import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../../app-types';
import { authErrors, bearer, json, jsonBody } from '../../core/openapi';
import { dateRangeQuery, idParam } from '../../core/schemas';
import { requireAuth } from '../../middleware/auth';
import { activityInputSchema, activityListSchema, activityPutResultSchema } from './activity.schemas';

export const activityRoutes = new OpenAPIHono<AppEnv>();
const secured = { security: bearer, middleware: [requireAuth] };
const uid = (c: { get(k: 'auth'): { userId: string } | undefined }) => c.get('auth')!.userId;

activityRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/activity/{id}',
    tags: ['Activity'],
    summary: 'Log exercise or a day’s steps (idempotent)',
    ...secured,
    description:
      'Without `caloriesBurned` the server estimates it from the kind, duration and the person’s weight and sets `caloriesEstimated: true`. The estimate is rough: show it as approximate.',
    request: { params: idParam, body: jsonBody(activityInputSchema) },
    responses: { 200: json(activityPutResultSchema, 'Stored, or the newer server version'), ...authErrors },
  }), // fmt: skip
  async (c) =>
    c.json(await c.get('deps').activity.put(uid(c), c.req.valid('param').id, c.req.valid('json')), 200),
);

activityRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/activity/{id}',
    tags: ['Activity'],
    summary: 'Delete an activity entry',
    ...secured,
    request: { params: idParam },
    responses: { 204: { description: 'Deleted (also returned if it was already gone)' }, ...authErrors },
  }), // fmt: skip
  async (c) => {
    await c.get('deps').activity.delete(uid(c), c.req.valid('param').id);
    return c.body(null, 204);
  },
);

activityRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/activity',
    tags: ['Activity'],
    summary: 'Activity between two dates (at most 366 days), with daily totals',
    ...secured,
    request: { query: dateRangeQuery },
    responses: { 200: json(activityListSchema, 'Oldest first'), ...authErrors },
  }), // fmt: skip
  async (c) => {
    const { from, to } = c.req.valid('query');
    return c.json(await c.get('deps').activity.list(uid(c), from, to), 200);
  },
);
