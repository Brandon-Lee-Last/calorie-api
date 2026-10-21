import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../../app-types';
import { authErrors, bearer, commonErrors, json, jsonBody } from '../../core/openapi';
import { idParam } from '../../core/schemas';
import { requireAuth } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rate-limit';
import {
  barcodeParamSchema,
  dishParamSchema,
  foodInputSchema,
  foodListSchema,
  foodPutResultSchema,
  foodRecordSchema,
  searchQuerySchema,
} from './foods.schemas';

export const foodsRoutes = new OpenAPIHono<AppEnv>();
const secured = { security: bearer, middleware: [requireAuth] };
const uid = (c: { get(k: 'auth'): { userId: string } | undefined }) => c.get('auth')!.userId;

// Static paths first so "search" and "barcode" are not read as ids.
foodsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/foods/search',
    tags: ['Foods'],
    summary: 'Search your foods and the shared catalogue',
    ...secured,
    description:
      'Every word in `q` must appear in the name or brand. Accents and case are ignored ("droewors" finds "Droëwors"). Your own foods come first.',
    request: { query: searchQuerySchema },
    responses: { 200: json(foodListSchema, 'Matches'), ...authErrors },
  }), // fmt: skip
  async (c) => {
    const { q, limit } = c.req.valid('query');
    return c.json(await c.get('deps').foods.search(uid(c), q, limit), 200);
  },
);

foodsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/foods/barcode/{code}',
    tags: ['Foods'],
    summary: 'Look up a packaged food by barcode',
    ...secured,
    description:
      'Checks your foods, then the shared catalogue, then Open Food Facts (credit it in the app: data under ODbL). 404 means no product with usable nutrition was found; 502 means the lookup service is down, so try again.',
    middleware: [requireAuth, rateLimit({ name: 'barcode', limit: 60, windowSeconds: 3600, by: 'user' })],
    request: { params: barcodeParamSchema },
    responses: {
      200: json(foodRecordSchema, 'The food'),
      404: commonErrors[400],
      502: commonErrors[400],
      ...authErrors,
    },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').foods.byBarcode(uid(c), c.req.valid('param').code), 200),
);

foodsRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/foods/{id}',
    tags: ['Foods'],
    summary: 'Create or edit one of your own foods (idempotent)',
    ...secured,
    request: { params: idParam, body: jsonBody(foodInputSchema) },
    responses: {
      200: json(foodPutResultSchema, 'Stored, or the newer server version'),
      409: commonErrors[400],
      ...authErrors,
    },
  }), // fmt: skip
  async (c) =>
    c.json(await c.get('deps').foods.putCustom(uid(c), c.req.valid('param').id, c.req.valid('json')), 200),
);

foodsRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/foods/{id}',
    tags: ['Foods'],
    summary: 'Delete one of your own foods',
    ...secured,
    request: { params: idParam },
    responses: { 204: { description: 'Deleted (also returned if it was already gone)' }, ...authErrors },
  }), // fmt: skip
  async (c) => {
    await c.get('deps').foods.deleteCustom(uid(c), c.req.valid('param').id);
    return c.body(null, 204);
  },
);

foodsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/foods/{id}',
    tags: ['Foods'],
    summary: 'One food: yours, or from the shared catalogue',
    ...secured,
    request: { params: idParam },
    responses: { 200: json(foodRecordSchema, 'The food'), 404: commonErrors[400], ...authErrors },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').foods.get(uid(c), c.req.valid('param').id), 200),
);

foodsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/foods/dish/{dishId}',
    tags: ['Foods'],
    summary: 'What the catalogue says a dish contains',
    ...secured,
    description:
      'Foods the catalogue links to a dish id from the model’s list (for example `bunny_chow`). An empty list means nobody has added sourced figures for it yet; the app must not invent any.',
    request: { params: dishParamSchema },
    responses: { 200: json(foodListSchema, 'Matching foods'), ...authErrors },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').foods.forDish(uid(c), c.req.valid('param').dishId), 200),
);
