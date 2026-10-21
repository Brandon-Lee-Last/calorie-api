import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../../app-types';
import { notFound } from '../../core/errors';
import { authErrors, bearer, commonErrors, json, jsonBody } from '../../core/openapi';
import { idParam } from '../../core/schemas';
import { requireAuth } from '../../middleware/auth';
import {
  recipeInputSchema,
  recipeListQuerySchema,
  recipeListSchema,
  recipePutResultSchema,
  recipeRecordSchema,
} from './recipes.schemas';

export const recipesRoutes = new OpenAPIHono<AppEnv>();
const secured = { security: bearer, middleware: [requireAuth] };
const uid = (c: { get(k: 'auth'): { userId: string } | undefined }) => c.get('auth')!.userId;

recipesRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/recipes/{id}',
    tags: ['Recipes'],
    summary: 'Create or update a recipe (idempotent)',
    ...secured,
    description:
      'Totals and per-serving figures are worked out here from the ingredients. Free accounts can keep a limited number of recipes (429 `quota_exceeded`, key `recipes`); editing an existing one never counts against the limit.',
    request: { params: idParam, body: jsonBody(recipeInputSchema) },
    responses: { 200: json(recipePutResultSchema, 'Stored, or the newer server version'), ...authErrors },
  }), // fmt: skip
  async (c) =>
    c.json(await c.get('deps').recipes.put(uid(c), c.req.valid('param').id, c.req.valid('json')), 200),
);

recipesRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/recipes/{id}',
    tags: ['Recipes'],
    summary: 'Delete a recipe',
    ...secured,
    request: { params: idParam },
    responses: { 204: { description: 'Deleted (also returned if it was already gone)' }, ...authErrors },
  }), // fmt: skip
  async (c) => {
    await c.get('deps').recipes.delete(uid(c), c.req.valid('param').id);
    return c.body(null, 204);
  },
);

recipesRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/recipes/{id}',
    tags: ['Recipes'],
    summary: 'One recipe',
    ...secured,
    request: { params: idParam },
    responses: { 200: json(recipeRecordSchema, 'The recipe'), 404: commonErrors[400], ...authErrors },
  }), // fmt: skip
  async (c) => {
    const recipe = await c.get('deps').recipes.get(uid(c), c.req.valid('param').id);
    if (!recipe) throw notFound('Recipe');
    return c.json(recipe, 200);
  },
);

recipesRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/recipes',
    tags: ['Recipes'],
    summary: 'Your recipes, A to Z',
    ...secured,
    request: { query: recipeListQuerySchema },
    responses: { 200: json(recipeListSchema, 'A page of recipes'), ...authErrors },
  }), // fmt: skip
  async (c) => {
    const { limit, cursor } = c.req.valid('query');
    return c.json(await c.get('deps').recipes.list(uid(c), limit, cursor), 200);
  },
);
