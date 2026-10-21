import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../../app-types';
import { commonErrors, json, jsonBody, z } from '../../core/openapi';
import { requireAdmin } from '../../middleware/admin';
import { importBodySchema, importResultSchema, MAX_IMPORT, retireParamSchema } from './catalogue.schemas';

export const catalogueRoutes = new OpenAPIHono<AppEnv>();
const guarded = { security: [{ adminKey: [] }], middleware: requireAdmin };

catalogueRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/admin/foods/import',
    tags: ['Admin'],
    summary: 'Add or update foods in the shared catalogue',
    ...guarded,
    description:
      `Up to ${MAX_IMPORT} foods per call, every number per 100 g, each with the \`source\` it came from (\`usda\`, \`curated\`, \`openfoodfacts\`) and a stable \`externalId\`. ` +
      'Running it again with the same ids updates in place. Rows that fail checks are listed in `rejected` by position while the rest go in. ' +
      'Only import figures from a source you are allowed to use: nothing here estimates or fills in missing values. ' +
      'Use `scripts/import-foods.mjs` to load a whole file (USDA FoodData Central JSON, CSV or JSON).',
    request: { body: jsonBody(importBodySchema) },
    responses: {
      200: json(importResultSchema, 'What was added, updated and refused'),
      401: commonErrors[400],
      422: commonErrors[422],
    },
  }), // fmt: skip
  async (c) => {
    const { foods, dryRun } = c.req.valid('json');
    return c.json(await c.get('deps').catalogue.import(foods, dryRun), 200);
  },
);

catalogueRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/admin/foods/{id}',
    tags: ['Admin'],
    summary: 'Remove a food from the shared catalogue',
    ...guarded,
    request: { params: retireParamSchema },
    responses: {
      200: json(z.object({ ok: z.literal(true) }), 'Removed'),
      401: commonErrors[400],
      404: commonErrors[400],
    },
  }), // fmt: skip
  async (c) => {
    await c.get('deps').catalogue.retire(c.req.valid('param').id);
    return c.json({ ok: true as const }, 200);
  },
);
