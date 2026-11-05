import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import type { AppEnv } from '../../app-types';
import { authErrors, bearer, commonErrors, json, jsonBody } from '../../core/openapi';
import { requireAdmin } from '../../middleware/admin';
import { requireAuth } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rate-limit';
import {
  codeInputSchema,
  codeResultSchema,
  partnerInputSchema,
  partnerPatchSchema,
  partnerReportSchema,
  partnerSchema,
  redeemResultSchema,
  rewardsSchema,
} from './rewards.schemas';

export const rewardsRoutes = new OpenAPIHono<AppEnv>();

rewardsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/rewards',
    tags: ['Rewards'],
    security: bearer,
    middleware: requireAuth,
    summary: 'Pango Points: the balance, the invite code, what earns points and what was earned',
    responses: { 200: json(rewardsSchema, 'Rewards'), ...authErrors },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').rewards.summary(c.get('auth')!.userId), 200),
);

rewardsRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/rewards/code',
    tags: ['Rewards'],
    security: bearer,
    middleware: [requireAuth, rateLimit({ name: 'reward-code', limit: 10, windowSeconds: 3600, by: 'user' })],
    summary: 'Enter a friend’s invite code or a partner’s (gym’s) code',
    request: { body: jsonBody(codeInputSchema) },
    responses: {
      ...authErrors,
      200: json(codeResultSchema, 'What the code was'),
      400: commonErrors[400],
      404: commonErrors[400],
      409: commonErrors[400],
    },
  }), // fmt: skip
  async (c) =>
    c.json(await c.get('deps').rewards.enterCode(c.get('auth')!.userId, c.req.valid('json').code), 200),
);

rewardsRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/rewards/redeem',
    tags: ['Rewards'],
    security: bearer,
    middleware: [
      requireAuth,
      rateLimit({ name: 'reward-redeem', limit: 5, windowSeconds: 3600, by: 'user' }),
    ],
    summary: 'Spend points on a month of Plus',
    responses: { 200: json(redeemResultSchema, 'Plus until'), 409: commonErrors[400], ...authErrors },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').rewards.redeem(c.get('auth')!.userId), 200),
);

// ---- admin: partners (gyms)

const idParam = z.object({ id: z.string().min(1).max(64) });

rewardsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/admin/partners',
    tags: ['Admin'],
    security: [{ adminKey: [] }],
    middleware: requireAdmin,
    summary: 'Partners with their members, members on Plus, and what they earned and are owed',
    responses: { 200: json(z.object({ items: z.array(partnerSchema) }), 'Partners'), 401: commonErrors[400] },
  }), // fmt: skip
  async (c) => c.json({ items: await c.get('deps').rewards.listPartners() }, 200),
);

rewardsRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/admin/partners',
    tags: ['Admin'],
    security: [{ adminKey: [] }],
    middleware: requireAdmin,
    summary: 'Add a partner (gym) with its own code',
    request: { body: jsonBody(partnerInputSchema) },
    responses: {
      200: json(partnerSchema, 'The partner'),
      400: commonErrors[400],
      401: commonErrors[400],
      409: commonErrors[400],
    },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').rewards.createPartner(c.req.valid('json')), 200),
);

rewardsRoutes.openapi(
  createRoute({
    method: 'patch',
    path: '/admin/partners/{id}',
    tags: ['Admin'],
    security: [{ adminKey: [] }],
    middleware: requireAdmin,
    summary: 'Change a partner’s terms, or stop its code (active: false)',
    request: { params: idParam, body: jsonBody(partnerPatchSchema) },
    responses: { 200: json(partnerSchema, 'The partner'), 401: commonErrors[400], 404: commonErrors[400] },
  }), // fmt: skip
  async (c) =>
    c.json(await c.get('deps').rewards.updatePartner(c.req.valid('param').id, c.req.valid('json')), 200),
);

rewardsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/admin/partners/{id}/report',
    tags: ['Admin'],
    security: [{ adminKey: [] }],
    middleware: requireAdmin,
    summary: 'A partner’s statement for a month: sign-ups, each paid Plus period and its share',
    request: { params: idParam, query: z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }) },
    responses: {
      200: json(partnerReportSchema, 'The statement'),
      401: commonErrors[400],
      404: commonErrors[400],
    },
  }), // fmt: skip
  async (c) =>
    c.json(await c.get('deps').rewards.report(c.req.valid('param').id, c.req.valid('query').month), 200),
);

rewardsRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/admin/partners/{id}/paid',
    tags: ['Admin'],
    security: [{ adminKey: [] }],
    middleware: requireAdmin,
    summary: 'Record a payout: everything owed before `until` is marked paid',
    request: { params: idParam, body: jsonBody(z.object({ until: z.number().int() })) },
    responses: {
      200: json(z.object({ rows: z.number().int(), cents: z.number().int() }), 'What was marked paid'),
      401: commonErrors[400],
      404: commonErrors[400],
    },
  }), // fmt: skip
  async (c) =>
    c.json(await c.get('deps').rewards.markPaid(c.req.valid('param').id, c.req.valid('json').until), 200),
);
