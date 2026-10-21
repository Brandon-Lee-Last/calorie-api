import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../../app-types';
import { badRequest } from '../../core/errors';
import { commonErrors, json, jsonBody, z } from '../../core/openapi';
import { requireAdmin } from '../../middleware/admin';
import {
  accuracyQuerySchema,
  accuracySchema,
  adminProgramListSchema,
  adminSlugParam,
  exerciseInputSchema,
  keyParam,
  mediaInputSchema,
  mediaRecordSchema,
  programInputSchema,
} from './admin.schemas'; // fmt: skip

export const adminRoutes = new OpenAPIHono<AppEnv>();
const guarded = {
  security: [{ adminKey: [] }],
  middleware: requireAdmin,
};
const unauthorised = { 401: commonErrors[400] };
const done = z.object({ ok: z.literal(true) });

adminRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/admin/media/{key}',
    tags: ['Admin'],
    summary: 'Create or update a media entry',
    ...guarded,
    description:
      'Media is addressed by a stable key you choose. For `r2` media, then upload the bytes with `PUT /admin/media/{key}/upload`.',
    request: { params: keyParam, body: jsonBody(mediaInputSchema) },
    responses: { 200: json(mediaRecordSchema, 'The media entry'), ...unauthorised, 422: commonErrors[422] },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').admin.putMedia(c.req.valid('param').key, c.req.valid('json')), 200),
);

adminRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/admin/media/{key}/upload',
    tags: ['Admin'],
    summary: 'Upload the file for an r2 media entry (up to 100 MB)',
    ...guarded,
    description:
      'Raw bytes as the request body, with the file’s Content-Type (video/mp4, video/webm, image/jpeg, image/png, image/webp, application/pdf). For bigger videos use Cloudflare Stream or an external link.',
    request: {
      params: keyParam,
      body: {
        required: true,
        content: { 'video/mp4': { schema: z.any() }, 'image/jpeg': { schema: z.any() } },
      },
    },
    responses: { 200: json(mediaRecordSchema, 'The media entry'), ...unauthorised },
  }), // fmt: skip
  async (c) => {
    const bytes = new Uint8Array(await c.req.raw.arrayBuffer());
    return c.json(
      await c.get('deps').admin.uploadMedia(c.req.valid('param').key, c.req.header('content-type'), bytes),
      200,
    );
  },
);

adminRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/admin/media/{key}',
    tags: ['Admin'],
    summary: 'Delete a media entry and its file',
    ...guarded,
    request: { params: keyParam },
    responses: { 204: { description: 'Deleted' }, ...unauthorised },
  }), // fmt: skip
  async (c) => {
    await c.get('deps').admin.deleteMedia(c.req.valid('param').key);
    return c.body(null, 204);
  },
);

adminRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/admin/exercises/{slug}',
    tags: ['Admin'],
    summary: 'Create or update an exercise',
    ...guarded,
    request: { params: adminSlugParam, body: jsonBody(exerciseInputSchema) },
    responses: { 200: json(z.object({ slug: z.string() }), 'Saved'), ...unauthorised },
  }), // fmt: skip
  async (c) =>
    c.json(await c.get('deps').admin.putExercise(c.req.valid('param').slug, c.req.valid('json')), 200),
);

adminRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/admin/exercises/{slug}',
    tags: ['Admin'],
    summary: 'Delete an exercise nobody uses',
    ...guarded,
    request: { params: adminSlugParam },
    responses: { 204: { description: 'Deleted' }, 409: commonErrors[400], ...unauthorised },
  }), // fmt: skip
  async (c) => {
    await c.get('deps').admin.deleteExercise(c.req.valid('param').slug);
    return c.body(null, 204);
  },
);

adminRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/admin/programs',
    tags: ['Admin'],
    summary: 'All programs, drafts included',
    ...guarded,
    responses: { 200: json(adminProgramListSchema, 'Programs'), ...unauthorised },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').admin.listPrograms(), 200),
);

adminRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/admin/programs/{slug}',
    tags: ['Admin'],
    summary: 'Create or replace a whole program (weeks, workouts, exercises)',
    ...guarded,
    description:
      'Atomic. Workouts are matched by `key`, so re-importing keeps the ids that people’s progress points at. A new program starts as a draft; an already published one stays published.',
    request: { params: adminSlugParam, body: jsonBody(programInputSchema) },
    responses: {
      200: json(
        z.object({ slug: z.string(), id: z.string(), published: z.boolean(), workouts: z.number().int() }),
        'Saved',
      ),
      422: commonErrors[422],
      ...unauthorised,
    },
  }), // fmt: skip
  async (c) =>
    c.json(await c.get('deps').admin.putProgram(c.req.valid('param').slug, c.req.valid('json')), 200),
);

adminRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/admin/programs/{slug}/publish',
    tags: ['Admin'],
    summary: 'Make a program visible in the app',
    ...guarded,
    request: { params: adminSlugParam },
    responses: {
      200: json(done, 'Published'),
      409: commonErrors[400],
      404: commonErrors[400],
      ...unauthorised,
    },
  }), // fmt: skip
  async (c) => {
    await c.get('deps').admin.publish(c.req.valid('param').slug);
    return c.json({ ok: true as const }, 200);
  },
);

adminRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/admin/programs/{slug}/unpublish',
    tags: ['Admin'],
    summary: 'Hide a program (people already following it keep their history)',
    ...guarded,
    request: { params: adminSlugParam },
    responses: { 200: json(done, 'Hidden'), 404: commonErrors[400], ...unauthorised },
  }), // fmt: skip
  async (c) => {
    await c.get('deps').admin.unpublish(c.req.valid('param').slug);
    return c.json({ ok: true as const }, 200);
  },
);

adminRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/admin/programs/{slug}',
    tags: ['Admin'],
    summary: 'Delete a program',
    ...guarded,
    request: { params: adminSlugParam },
    responses: { 204: { description: 'Deleted' }, ...unauthorised },
  }), // fmt: skip
  async (c) => {
    await c.get('deps').admin.deleteProgram(c.req.valid('param').slug);
    return c.body(null, 204);
  },
);

adminRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/admin/scans/accuracy',
    tags: ['Admin'],
    summary: 'How the on-device model is doing, from what people kept',
    ...guarded,
    description:
      'Per model version: how many scans, how often people changed the result, and by how much. A person’s portion choice is not counted as a correction.',
    request: { query: accuracyQuerySchema },
    responses: { 200: json(accuracySchema, 'Per model'), ...unauthorised },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').admin.scanAccuracy(c.req.valid('query').modelVersion ?? null), 200),
);

export { badRequest };

adminRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/admin/maintenance/run',
    tags: ['Admin'],
    summary: 'Run the nightly housekeeping now',
    ...guarded,
    description:
      'Removes expired sign-in tokens, old deletion markers and old usage counters. It also runs by itself every night.',
    responses: { 200: json(z.record(z.string(), z.unknown()), 'What was removed'), ...unauthorised },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').maintenance.run(), 200),
);
