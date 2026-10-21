import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../../app-types';
import { authErrors, bearer, commonErrors, json, jsonBody } from '../../core/openapi';
import { dateRangeQuery, idParam } from '../../core/schemas';
import { requireAuth } from '../../middleware/auth';
import {
  sessionInputSchema,
  sessionListSchema,
  sessionPutResultSchema,
  statsSchema,
} from './sessions.schemas';

export const sessionsRoutes = new OpenAPIHono<AppEnv>();
const secured = { security: bearer, middleware: [requireAuth] };
const uid = (c: { get(k: 'auth'): { userId: string } | undefined }) => c.get('auth')!.userId;

sessionsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/training/sessions',
    tags: ['Training'],
    summary: 'Logged workouts between two dates (at most 366 days)',
    ...secured,
    request: { query: dateRangeQuery },
    responses: { 200: json(sessionListSchema, 'Oldest first'), ...authErrors },
  }), // fmt: skip
  async (c) => {
    const { from, to } = c.req.valid('query');
    return c.json(await c.get('deps').sessions.list(uid(c), from, to), 200);
  },
);

sessionsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/training/stats',
    tags: ['Training'],
    summary: 'Totals over finished sessions between two dates',
    ...secured,
    request: { query: dateRangeQuery },
    responses: { 200: json(statsSchema, 'Totals'), ...authErrors },
  }), // fmt: skip
  async (c) => {
    const { from, to } = c.req.valid('query');
    return c.json(await c.get('deps').sessions.stats(uid(c), from, to), 200);
  },
);

sessionsRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/training/sessions/{id}',
    tags: ['Training'],
    summary: 'Log or edit a workout (idempotent)',
    ...secured,
    description:
      'Free for everyone. Include `programId` and `workoutId` when it was a workout from a program, so progress advances; finishing the last workout of the program completes it.',
    request: { params: idParam, body: jsonBody(sessionInputSchema) },
    responses: {
      200: json(sessionPutResultSchema, 'Stored, or the newer server version'),
      409: commonErrors[400],
      ...authErrors,
    },
  }), // fmt: skip
  async (c) =>
    c.json(await c.get('deps').sessions.put(uid(c), c.req.valid('param').id, c.req.valid('json')), 200),
);

sessionsRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/training/sessions/{id}',
    tags: ['Training'],
    summary: 'Delete a logged workout',
    ...secured,
    request: { params: idParam },
    responses: { 204: { description: 'Deleted (also returned if it was already gone)' }, ...authErrors },
  }), // fmt: skip
  async (c) => {
    await c.get('deps').sessions.delete(uid(c), c.req.valid('param').id);
    return c.body(null, 204);
  },
);
