import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../../app-types';
import { authErrors, bearer, json, jsonBody } from '../../core/openapi';
import { requireAuth } from '../../middleware/auth';
import { pullQuerySchema, pullResultSchema, pushBodySchema, pushResultSchema } from './sync.schemas';

export const syncRoutes = new OpenAPIHono<AppEnv>();
const secured = { security: bearer, middleware: [requireAuth] };
const uid = (c: { get(k: 'auth'): { userId: string } | undefined }) => c.get('auth')!.userId;

syncRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/sync/pull',
    tags: ['Sync'],
    summary: 'Everything that changed since revision N',
    ...secured,
    description:
      'Call with `since=0` on a new device, then with the returned `rev` each time. While `hasMore` is true, call again immediately. Deleted records arrive with `deletedAt` set.',
    request: { query: pullQuerySchema },
    responses: { 200: json(pullResultSchema, 'Changes, oldest first'), ...authErrors },
  }), // fmt: skip
  async (c) => {
    const { since, limit } = c.req.valid('query');
    return c.json(await c.get('deps').sync.pull(uid(c), since, limit), 200);
  },
);

syncRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/sync/push',
    tags: ['Sync'],
    summary: 'Upload changes made offline (up to 50 at a time)',
    ...secured,
    description:
      'Each op is applied independently and reported in `results`, in the same order. A bad op does not stop the others. `stale` means the server already holds a newer edit; take the returned `record`.',
    request: { body: jsonBody(pushBodySchema) },
    responses: { 200: json(pushResultSchema, 'One result per op'), ...authErrors },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').sync.push(uid(c), c.req.valid('json').ops), 200),
);
