import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../../app-types';
import { authErrors, bearer, commonErrors, json, z } from '../../core/openapi';
import { dateRangeQuery, idParam } from '../../core/schemas';
import { requireAuth } from '../../middleware/auth';
import { readImageUpload } from '../media/object-storage';
import { MAX_PHOTO_BYTES } from './diary.service';
import {
  entryInputSchema,
  entryListSchema,
  entryPutResultSchema,
  entryRecordSchema,
  recentListSchema,
  recentQuerySchema,
  summarySchema,
} from './diary.schemas'; // fmt: skip

export const diaryRoutes = new OpenAPIHono<AppEnv>();
const secured = { security: bearer, middleware: [requireAuth] };
const uid = (c: { get(k: 'auth'): { userId: string } | undefined }) => c.get('auth')!.userId;

diaryRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/diary/entries/{id}',
    tags: ['Diary'],
    summary: 'Log or edit a meal (idempotent)',
    ...secured,
    description:
      'The id is made by the app. Sending the same record again is harmless; when two devices edit the same entry, the later `clientUpdatedAt` wins and `applied` says which happened.',
    request: {
      params: idParam,
      body: { required: true, content: { 'application/json': { schema: entryInputSchema } } },
    },
    responses: {
      200: json(entryPutResultSchema, 'Stored, or the newer server version'),
      409: commonErrors[400],
      ...authErrors,
    },
  }), // fmt: skip
  async (c) =>
    c.json(await c.get('deps').diary.put(uid(c), c.req.valid('param').id, c.req.valid('json')), 200),
);

diaryRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/diary/entries/{id}',
    tags: ['Diary'],
    summary: 'Delete a meal (and its photo)',
    ...secured,
    request: { params: idParam },
    responses: { 204: { description: 'Deleted (also returned if it was already gone)' }, ...authErrors },
  }), // fmt: skip
  async (c) => {
    await c.get('deps').diary.delete(uid(c), c.req.valid('param').id);
    return c.body(null, 204);
  },
);

diaryRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/diary/entries',
    tags: ['Diary'],
    summary: 'Meals between two dates (at most 62 days)',
    ...secured,
    request: { query: dateRangeQuery },
    responses: { 200: json(entryListSchema, 'Oldest first'), ...authErrors },
  }), // fmt: skip
  async (c) => {
    const { from, to } = c.req.valid('query');
    return c.json(await c.get('deps').diary.list(uid(c), from, to), 200);
  },
);

diaryRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/diary/summary',
    tags: ['Diary'],
    summary: 'Daily totals (calories, macros, water) between two dates (at most 366 days)',
    ...secured,
    request: { query: dateRangeQuery },
    responses: { 200: json(summarySchema, 'One row per day that has data'), ...authErrors },
  }), // fmt: skip
  async (c) => {
    const { from, to } = c.req.valid('query');
    return c.json(await c.get('deps').diary.summary(uid(c), from, to), 200);
  },
);

diaryRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/diary/recent',
    tags: ['Diary'],
    summary: 'Recently logged foods, for one-tap re-logging',
    ...secured,
    request: { query: recentQuerySchema },
    responses: { 200: json(recentListSchema, 'Newest first, one row per food name'), ...authErrors },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').diary.recent(uid(c), c.req.valid('query').limit), 200),
);

diaryRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/diary/entries/{id}/photo',
    tags: ['Diary'],
    summary: 'Attach a photo to a meal',
    ...secured,
    description: `Send the raw image bytes as the body with a Content-Type of image/jpeg, image/png or image/webp, up to ${MAX_PHOTO_BYTES / 1024 / 1024} MB. Resize on the phone first (about 1024 px is plenty).`,
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
    responses: { 200: json(entryRecordSchema, 'The updated entry'), ...authErrors },
  }), // fmt: skip
  async (c) => {
    const upload = await readImageUpload(c.req.raw, MAX_PHOTO_BYTES);
    return c.json(await c.get('deps').diary.setPhoto(uid(c), c.req.valid('param').id, upload), 200);
  },
);

diaryRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/diary/entries/{id}/photo',
    tags: ['Diary'],
    summary: 'The meal photo',
    ...secured,
    request: { params: idParam },
    responses: {
      200: { description: 'The image', content: { 'image/jpeg': { schema: z.any() } } },
      ...authErrors,
    },
  }), // fmt: skip
  async (c) => {
    const object = await c.get('deps').diary.getPhoto(uid(c), c.req.valid('param').id);
    return new Response(object.body, {
      headers: {
        'content-type': object.httpMetadata?.contentType ?? 'application/octet-stream',
        'cache-control': 'private, max-age=3600',
        etag: object.httpEtag,
      },
    }) as never;
  },
);

diaryRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/diary/entries/{id}/photo',
    tags: ['Diary'],
    summary: 'Remove the meal photo',
    ...secured,
    request: { params: idParam },
    responses: { 204: { description: 'Removed (also returned if there was none)' }, ...authErrors },
  }), // fmt: skip
  async (c) => {
    await c.get('deps').diary.deletePhoto(uid(c), c.req.valid('param').id);
    return c.body(null, 204);
  },
);

export { dateRangeQuery };
