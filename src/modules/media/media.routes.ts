import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../../app-types';
import { authErrors, bearer, commonErrors, json, z } from '../../core/openapi';
import { requireAuth } from '../../middleware/auth';
import { mediaAccessSchema, mediaFileQuerySchema, mediaIdParam } from './media.schemas';

export const mediaRoutes = new OpenAPIHono<AppEnv>();

mediaRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/media/{id}/access',
    tags: ['Media'],
    summary: 'Get a link to play a video or show an image',
    security: bearer,
    description:
      'Checks the account may see this media (Pro media needs a Pro subscription: 402 otherwise) and returns a link that works for an hour.',
    middleware: [requireAuth],
    request: { params: mediaIdParam },
    responses: {
      200: json(mediaAccessSchema, 'A temporary link'),
      402: commonErrors[400],
      404: commonErrors[400],
      ...authErrors,
    },
  }), // fmt: skip
  async (c) => {
    const origin = new URL(c.req.url).origin;
    return c.json(
      await c.get('deps').media.access(c.get('auth')!.userId, c.req.valid('param').id, origin),
      200,
    );
  },
);

// No sign-in header here on purpose: video players cannot send one. The signed link in the query is the permission.
mediaRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/media/{id}/file',
    tags: ['Media'],
    summary: 'The file behind a temporary link',
    description:
      'Supports `Range` (so players can seek) and `If-None-Match`. 403 when the link is invalid or has expired.',
    request: { params: mediaIdParam, query: mediaFileQuerySchema },
    responses: {
      200: { description: 'The file', content: { 'application/octet-stream': { schema: z.any() } } },
      206: { description: 'Part of the file' },
      403: commonErrors[400],
      404: commonErrors[400],
      416: { description: 'Range not satisfiable' },
    },
  }), // fmt: skip
  async (c) => {
    const { exp, sig } = c.req.valid('query');
    const res = await c.get('deps').media.serve(c.req.valid('param').id, exp, sig, {
      range: c.req.header('range') ?? null,
      ifNoneMatch: c.req.header('if-none-match') ?? null,
    });
    return res as never;
  },
);
