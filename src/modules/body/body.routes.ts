import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../../app-types';
import { authErrors, bearer, json, jsonBody } from '../../core/openapi';
import { dateRangeQuery, idParam } from '../../core/schemas';
import { requireAuth } from '../../middleware/auth';
import {
  putResultSchema,
  waterInputSchema,
  waterListSchema,
  waterRecordSchema,
  weightInputSchema,
  weightListSchema,
  weightRecordSchema,
} from './body.schemas'; // fmt: skip

export const bodyRoutes = new OpenAPIHono<AppEnv>();
const secured = { security: bearer, middleware: [requireAuth] };
const uid = (c: { get(k: 'auth'): { userId: string } | undefined }) => c.get('auth')!.userId;
const noContent = { 204: { description: 'Deleted (also returned if it was already gone)' } };

const weightPut = putResultSchema(weightRecordSchema, 'WeightPutResult');
const waterPut = putResultSchema(waterRecordSchema, 'WaterPutResult');

bodyRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/weight/{id}',
    tags: ['Weight'],
    summary: 'Create or update a weight entry (idempotent)',
    ...secured,
    request: { params: idParam, body: jsonBody(weightInputSchema) },
    responses: { 200: json(weightPut, 'Stored, or the newer server version'), ...authErrors },
  }), // fmt: skip
  async (c) =>
    c.json(await c.get('deps').body.putWeight(uid(c), c.req.valid('param').id, c.req.valid('json')), 200),
);

bodyRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/weight/{id}',
    tags: ['Weight'],
    summary: 'Delete a weight entry',
    ...secured,
    request: { params: idParam },
    responses: { ...noContent, ...authErrors },
  }), // fmt: skip
  async (c) => {
    await c.get('deps').body.deleteWeight(uid(c), c.req.valid('param').id);
    return c.body(null, 204);
  },
);

bodyRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/weight',
    tags: ['Weight'],
    summary: 'Weight entries between two dates (at most 366 days)',
    ...secured,
    request: { query: dateRangeQuery },
    responses: { 200: json(weightListSchema, 'Oldest first'), ...authErrors },
  }), // fmt: skip
  async (c) => {
    const { from, to } = c.req.valid('query');
    return c.json(await c.get('deps').body.listWeight(uid(c), from, to), 200);
  },
);

bodyRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/water/{id}',
    tags: ['Water'],
    summary: 'Create or update a water entry (idempotent)',
    ...secured,
    request: { params: idParam, body: jsonBody(waterInputSchema) },
    responses: { 200: json(waterPut, 'Stored, or the newer server version'), ...authErrors },
  }), // fmt: skip
  async (c) =>
    c.json(await c.get('deps').body.putWater(uid(c), c.req.valid('param').id, c.req.valid('json')), 200),
);

bodyRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/water/{id}',
    tags: ['Water'],
    summary: 'Delete a water entry',
    ...secured,
    request: { params: idParam },
    responses: { ...noContent, ...authErrors },
  }), // fmt: skip
  async (c) => {
    await c.get('deps').body.deleteWater(uid(c), c.req.valid('param').id);
    return c.body(null, 204);
  },
);

bodyRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/water',
    tags: ['Water'],
    summary: 'Water entries and daily totals between two dates (at most 366 days)',
    ...secured,
    request: { query: dateRangeQuery },
    responses: { 200: json(waterListSchema, 'Entries and totals'), ...authErrors },
  }), // fmt: skip
  async (c) => {
    const { from, to } = c.req.valid('query');
    return c.json(await c.get('deps').body.listWater(uid(c), from, to), 200);
  },
);
