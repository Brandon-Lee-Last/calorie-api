import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../../app-types';
import { authErrors, bearer, json, jsonBody } from '../../core/openapi';
import { idParam } from '../../core/schemas';
import { requireAuth } from '../../middleware/auth';
import {
  measurementInputSchema,
  measurementListSchema,
  measurementPutResultSchema,
  measurementQuerySchema,
} from './measurements.schemas';

export const measurementsRoutes = new OpenAPIHono<AppEnv>();
const secured = { security: bearer, middleware: [requireAuth] };
const uid = (c: { get(k: 'auth'): { userId: string } | undefined }) => c.get('auth')!.userId;

measurementsRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/measurements/{id}',
    tags: ['Measurements'],
    summary: 'Log a body measurement (idempotent)',
    ...secured,
    description:
      'One reading of one kind: waist in cm, body fat in percent, and so on. Values outside a believable range for the kind are refused.',
    request: { params: idParam, body: jsonBody(measurementInputSchema) },
    responses: {
      200: json(measurementPutResultSchema, 'Stored, or the newer server version'),
      ...authErrors,
    },
  }), // fmt: skip
  async (c) =>
    c.json(await c.get('deps').measurements.put(uid(c), c.req.valid('param').id, c.req.valid('json')), 200),
);

measurementsRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/measurements/{id}',
    tags: ['Measurements'],
    summary: 'Delete a measurement',
    ...secured,
    request: { params: idParam },
    responses: { 204: { description: 'Deleted (also returned if it was already gone)' }, ...authErrors },
  }), // fmt: skip
  async (c) => {
    await c.get('deps').measurements.delete(uid(c), c.req.valid('param').id);
    return c.body(null, 204);
  },
);

measurementsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/measurements',
    tags: ['Measurements'],
    summary: 'Measurements between two dates (at most 366 days), optionally of one kind',
    ...secured,
    request: { query: measurementQuerySchema },
    responses: { 200: json(measurementListSchema, 'Oldest first'), ...authErrors },
  }), // fmt: skip
  async (c) => {
    const { from, to, type } = c.req.valid('query');
    return c.json(await c.get('deps').measurements.list(uid(c), from, to, type ?? null), 200);
  },
);
