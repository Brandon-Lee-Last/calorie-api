import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../../app-types';
import { authErrors, bearer, commonErrors, json, jsonBody, z } from '../../core/openapi';
import { idParam } from '../../core/schemas';
import { requireAuth } from '../../middleware/auth';
import { readImageUpload } from '../media/object-storage';
import { MAX_PROGRESS_PHOTO_BYTES } from './progress.service';
import {
  dateRangeQuery,
  progressInputSchema,
  progressListSchema,
  progressPutResultSchema,
  progressRecordSchema,
} from './progress.schemas';

export const progressRoutes = new OpenAPIHono<AppEnv>();
const secured = { security: bearer, middleware: [requireAuth] };
const uid = (c: { get(k: 'auth'): { userId: string } | undefined }) => c.get('auth')!.userId;

progressRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/progress/{id}',
    tags: ['Progress'],
    summary: 'Create or update a progress entry (idempotent)',
    ...secured,
    description:
      'The details of a progress photo. Attach the picture itself with `PUT /progress/{id}/photo`.',
    request: { params: idParam, body: jsonBody(progressInputSchema) },
    responses: { 200: json(progressPutResultSchema, 'Stored, or the newer server version'), ...authErrors },
  }), // fmt: skip
  async (c) =>
    c.json(await c.get('deps').progress.put(uid(c), c.req.valid('param').id, c.req.valid('json')), 200),
);

progressRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/progress/{id}',
    tags: ['Progress'],
    summary: 'Delete a progress entry (and its photo)',
    ...secured,
    request: { params: idParam },
    responses: { 204: { description: 'Deleted (also returned if it was already gone)' }, ...authErrors },
  }), // fmt: skip
  async (c) => {
    await c.get('deps').progress.delete(uid(c), c.req.valid('param').id);
    return c.body(null, 204);
  },
);

progressRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/progress',
    tags: ['Progress'],
    summary: 'Progress entries between two dates (at most three years)',
    ...secured,
    request: { query: dateRangeQuery },
    responses: { 200: json(progressListSchema, 'Oldest first'), ...authErrors },
  }), // fmt: skip
  async (c) => {
    const { from, to } = c.req.valid('query');
    return c.json(await c.get('deps').progress.list(uid(c), from, to), 200);
  },
);

progressRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/progress/{id}/photo',
    tags: ['Progress'],
    summary: 'Attach the photo to a progress entry',
    ...secured,
    description: `Raw image bytes as the body, Content-Type image/jpeg, image/png or image/webp, up to ${MAX_PROGRESS_PHOTO_BYTES / 1024 / 1024} MB. Free accounts can keep a limited number (429 \`quota_exceeded\`, key \`progress_photos\`); replacing a photo never counts against the limit.`,
    request: {
      params: idParam,
      body: {
        required: true,
        content: {
          'image/jpeg': { schema: z.any() },
          'image/png': { schema: z.any() },
          'image/webp': { schema: z.any() },
        },
      },
    },
    responses: {
      200: json(progressRecordSchema, 'The updated entry'),
      404: commonErrors[400],
      ...authErrors,
    },
  }), // fmt: skip
  async (c) => {
    const upload = await readImageUpload(c.req.raw, MAX_PROGRESS_PHOTO_BYTES);
    return c.json(await c.get('deps').progress.setPhoto(uid(c), c.req.valid('param').id, upload), 200);
  },
);

progressRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/progress/{id}/photo',
    tags: ['Progress'],
    summary: 'The progress photo',
    ...secured,
    request: { params: idParam },
    responses: {
      200: { description: 'The image', content: { 'image/jpeg': { schema: z.any() } } },
      404: commonErrors[400],
      ...authErrors,
    },
  }), // fmt: skip
  async (c) => {
    const object = await c.get('deps').progress.getPhoto(uid(c), c.req.valid('param').id);
    return new Response(object.body, {
      headers: {
        'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
        'cache-control': 'private, max-age=3600',
        etag: object.httpEtag,
      },
    }) as never;
  },
);

progressRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/progress/{id}/photo',
    tags: ['Progress'],
    summary: 'Remove the photo but keep the entry',
    ...secured,
    request: { params: idParam },
    responses: { 204: { description: 'Removed (also returned if there was none)' }, ...authErrors },
  }), // fmt: skip
  async (c) => {
    await c.get('deps').progress.deletePhoto(uid(c), c.req.valid('param').id);
    return c.body(null, 204);
  },
);
