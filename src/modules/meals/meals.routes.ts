import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../../app-types';
import { authErrors, bearer, commonErrors, json, jsonBody, z } from '../../core/openapi';
import { requireAdmin } from '../../middleware/admin';
import { requireAuth } from '../../middleware/auth';
import { adminSlugParam } from '../admin/admin.schemas';
import { adminMealPlansSchema, dietInputSchema, mealInputSchema, mealPlansSchema } from './meals.schemas';

export const mealsRoutes = new OpenAPIHono<AppEnv>();
const secured = { security: bearer, middleware: [requireAuth] };
const guarded = { security: [{ adminKey: [] }], middleware: requireAdmin };
const unauthorised = { 401: commonErrors[400] };
const saved = json(z.object({ slug: z.string() }), 'Saved');

mealsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/meal-plans',
    tags: ['Meal plans'],
    summary: 'Diet styles and the meals plans are made from',
    ...secured,
    description:
      'Everything in one answer (it is small), so the phone can plan any day offline. Pro styles are `locked` on a free account, and so are meals found only in Pro styles: those come without ingredients or steps.',
    responses: { 200: json(mealPlansSchema, 'Diets and meals'), ...authErrors },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').meals.plans(c.get('auth')!.userId), 200),
);

mealsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/admin/meal-plans',
    tags: ['Admin'],
    summary: 'The slugs of every diet and meal',
    ...guarded,
    responses: { 200: json(adminMealPlansSchema, 'Slugs'), ...unauthorised },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').meals.slugs(), 200),
);

mealsRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/admin/diets/{slug}',
    tags: ['Admin'],
    summary: 'Create or update a diet style',
    ...guarded,
    request: { params: adminSlugParam, body: jsonBody(dietInputSchema) },
    responses: { 200: saved, ...unauthorised },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').meals.putDiet(c.req.valid('param').slug, c.req.valid('json')), 200),
);

mealsRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/admin/diets/{slug}',
    tags: ['Admin'],
    summary: 'Delete a diet style no meal uses',
    ...guarded,
    request: { params: adminSlugParam },
    responses: { 204: { description: 'Deleted' }, 409: commonErrors[400], ...unauthorised },
  }), // fmt: skip
  async (c) => {
    await c.get('deps').meals.deleteDiet(c.req.valid('param').slug);
    return c.body(null, 204);
  },
);

mealsRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/admin/meals/{slug}',
    tags: ['Admin'],
    summary: 'Create or update a meal',
    ...guarded,
    description:
      'Every diet it names must exist. Calories must roughly match 4 kcal/g protein and carbs and 9 kcal/g fat.',
    request: { params: adminSlugParam, body: jsonBody(mealInputSchema) },
    responses: { 200: saved, 422: commonErrors[422], ...unauthorised },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').meals.putMeal(c.req.valid('param').slug, c.req.valid('json')), 200),
);

mealsRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/admin/meals/{slug}',
    tags: ['Admin'],
    summary: 'Delete a meal',
    ...guarded,
    request: { params: adminSlugParam },
    responses: { 204: { description: 'Deleted' }, ...unauthorised },
  }), // fmt: skip
  async (c) => {
    await c.get('deps').meals.deleteMeal(c.req.valid('param').slug);
    return c.body(null, 204);
  },
);
