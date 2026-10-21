import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../../app-types';
import { authErrors, bearer, commonErrors, json, jsonBody, z } from '../../core/openapi';
import { idParam } from '../../core/schemas';
import { requireAuth } from '../../middleware/auth';
import { readImageUpload } from '../media/object-storage';
import { scanInputSchema, scanRecordSchema } from './scans.schemas';
import { MAX_CONTRIBUTION_BYTES } from './scans.service';

export const scansRoutes = new OpenAPIHono<AppEnv>();
const secured = { security: bearer, middleware: [requireAuth] };
const uid = (c: { get(k: 'auth'): { userId: string } | undefined }) => c.get('auth')!.userId;

scansRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/scans/{id}',
    tags: ['Scans'],
    summary: 'Report what the on-device model said and what the person kept',
    ...secured,
    description:
      'Idempotent. Repeat it when the outcome changes (saved, then edited). This is the signal for improving the model; it never blocks the app, so call it in the background.',
    request: { params: idParam, body: jsonBody(scanInputSchema) },
    responses: { 200: json(scanRecordSchema, 'Recorded'), 409: commonErrors[400], ...authErrors },
  }), // fmt: skip
  async (c) =>
    c.json(await c.get('deps').scans.record(uid(c), c.req.valid('param').id, c.req.valid('json')), 200),
);

scansRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/scans/{id}',
    tags: ['Scans'],
    summary: 'One recorded scan',
    ...secured,
    request: { params: idParam },
    responses: { 200: json(scanRecordSchema, 'The scan'), 404: commonErrors[400], ...authErrors },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').scans.get(uid(c), c.req.valid('param').id), 200),
);

scansRoutes.openapi(
  createRoute({
    method: 'put',
    path: '/scans/{id}/photo',
    tags: ['Scans'],
    summary: 'Contribute the photo to improve the model (needs consent)',
    ...secured,
    description:
      'Only accepted when the scan was recorded with `contributeConsent: true`. Raw image bytes, up to 3 MB. Withdraw by re-sending the scan with consent false, or `DELETE` this path.',
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
    responses: { 200: json(scanRecordSchema, 'The scan'), ...authErrors },
  }), // fmt: skip
  async (c) => {
    const upload = await readImageUpload(c.req.raw, MAX_CONTRIBUTION_BYTES);
    return c.json(await c.get('deps').scans.contributePhoto(uid(c), c.req.valid('param').id, upload), 200);
  },
);

scansRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/scans/{id}/photo',
    tags: ['Scans'],
    summary: 'Withdraw a contributed photo',
    ...secured,
    request: { params: idParam },
    responses: { 204: { description: 'Removed (also returned if there was none)' }, ...authErrors },
  }), // fmt: skip
  async (c) => {
    await c.get('deps').scans.deleteContribution(uid(c), c.req.valid('param').id);
    return c.body(null, 204);
  },
);
