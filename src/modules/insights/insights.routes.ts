import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../../app-types';
import { authErrors, bearer, commonErrors, json } from '../../core/openapi';
import { requireAuth } from '../../middleware/auth';
import { overviewSchema, weeklyQuerySchema, weeklySchema } from './insights.schemas';

export const insightsRoutes = new OpenAPIHono<AppEnv>();
const secured = { security: bearer, middleware: [requireAuth] };
const uid = (c: { get(k: 'auth'): { userId: string } | undefined }) => c.get('auth')!.userId;

insightsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/insights/overview',
    tags: ['Insights'],
    summary: 'Today at a glance: totals, goals and the logging streak',
    ...secured,
    responses: { 200: json(overviewSchema, 'The overview'), ...authErrors },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').insights.overview(uid(c)), 200),
);

insightsRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/insights/weekly',
    tags: ['Insights'],
    summary: 'A week in numbers, with plain highlights',
    ...secured,
    description:
      'Free accounts get calories, days logged and the streak; Pro adds macros, water, weight change, training and last week’s comparison. `narrative=true` (Pro) adds a short written summary, written by AI from those numbers.',
    request: { query: weeklyQuerySchema },
    responses: { 200: json(weeklySchema, 'The week'), 402: commonErrors[400], ...authErrors },
  }), // fmt: skip
  async (c) => {
    const { end, narrative } = c.req.valid('query');
    return c.json(await c.get('deps').insights.weekly(uid(c), { end, narrative }), 200);
  },
);
