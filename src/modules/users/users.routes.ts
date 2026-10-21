import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../../app-types';
import { authErrors, bearer, json, jsonBody } from '../../core/openapi';
import { requireAuth } from '../../middleware/auth';
import {
  goalsResponseSchema,
  goalsSchema,
  mePatchSchema,
  meSchema,
  profilePatchSchema,
  profileSchema,
  recommendationSchema,
} from './users.schemas';

export const usersRoutes = new OpenAPIHono<AppEnv>();
const secured = { security: bearer, middleware: [requireAuth] };
const uid = (c: { get(k: 'auth'): { userId: string } | undefined }) => c.get('auth')!.userId;

usersRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/me',
    tags: ['Me'],
    summary: 'The signed-in account',
    ...secured,
    responses: { 200: json(meSchema, 'The account'), ...authErrors },
  }),
  async (c) => c.json(await c.get('deps').users.getMe(uid(c)), 200),
);

usersRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/me',
    tags: ['Me'],
    summary: 'Change the display name',
    ...secured,
    request: { body: jsonBody(mePatchSchema) },
    responses: { 200: json(meSchema, 'The updated account'), ...authErrors },
  }),
  async (c) =>
    c.json(await c.get('deps').users.updateDisplayName(uid(c), c.req.valid('json').displayName), 200),
);

usersRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/me/profile',
    tags: ['Me'],
    summary: 'Body stats, preferences and goals',
    ...secured,
    responses: { 200: json(profileSchema, 'The profile'), ...authErrors },
  }),
  async (c) => c.json(await c.get('deps').users.getProfile(uid(c)), 200),
);

usersRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/me/profile',
    tags: ['Me'],
    summary: 'Update any of the profile fields',
    description:
      'Only the fields you send change; send `null` to clear an optional one. Unless the goals were set by hand, they are recalculated from the new body stats.',
    ...secured,
    request: { body: jsonBody(profilePatchSchema) },
    responses: { 200: json(profileSchema, 'The updated profile'), ...authErrors },
  }),
  async (c) => c.json(await c.get('deps').users.patchProfile(uid(c), c.req.valid('json')), 200),
);

usersRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/me/goals',
    tags: ['Me'],
    summary: 'Set calorie and macro goals by hand',
    description: 'Marks the goals as custom, so changing body stats no longer recalculates them.',
    ...secured,
    request: { body: jsonBody(goalsSchema) },
    responses: { 200: json(profileSchema, 'The updated profile'), ...authErrors },
  }),
  async (c) => c.json(await c.get('deps').users.setGoals(uid(c), c.req.valid('json')), 200),
);

usersRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/me/goals/recommendation',
    tags: ['Me'],
    summary: 'Calorie and macro goals worked out from the profile',
    description:
      'Fails with `bad_request` (`reason: profile_incomplete`) listing what is missing. An estimate from a population formula, not medical advice.',
    ...secured,
    responses: { 200: json(recommendationSchema, 'The recommendation'), ...authErrors },
  }),
  async (c) => c.json(await c.get('deps').users.recommendation(uid(c)), 200),
);

usersRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/me/goals/apply-recommendation',
    tags: ['Me'],
    summary: 'Use the recommended goals (and let them follow the profile again)',
    ...secured,
    responses: { 200: json(profileSchema, 'The updated profile'), ...authErrors },
  }),
  async (c) => c.json(await c.get('deps').users.applyRecommendation(uid(c)), 200),
);

export { goalsResponseSchema };
