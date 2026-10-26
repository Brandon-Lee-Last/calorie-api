import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../../app-types';
import { aiBudgetExceeded } from '../../core/errors';
import { authErrors, bearer, commonErrors, json, jsonBody } from '../../core/openapi';
import { requireAdmin } from '../../middleware/admin';
import { requireAuth } from '../../middleware/auth';
import { requireFeature } from '../../middleware/feature';
import { rateLimit } from '../../middleware/rate-limit';
import type { Allowance } from './coach.service';
import {
  askResultSchema,
  askSchema,
  evalResultSchema,
  evalSchema,
  historySchema,
  pantryAskSchema,
  pantryResultSchema,
} from './coach.schemas';

export const coachRoutes = new OpenAPIHono<AppEnv>();
type Ctx = Parameters<Parameters<typeof coachRoutes.openapi>[1]>[0];

/** The person's daily coach allowance, behind the service-wide AI budget. Taken only when a model is about to run. */
export function coachAllowance(c: Ctx): Allowance {
  const d = c.get('deps');
  const userId = c.get('auth')!.userId;
  return {
    async take() {
      const budget = await d.strictLimiter.hit('ai-budget', d.config.AI_DAILY_BUDGET, 86400);
      if (!budget.allowed) {
        await d.alerts.notify({
          key: 'ai-budget',
          title: 'The daily AI budget is used up, so AI features are paused until it resets',
          detail: `Budget: ${d.config.AI_DAILY_BUDGET} calls per day. Raise AI_DAILY_BUDGET if this is real growth, look for abuse if not.`,
        });
        throw aiBudgetExceeded(budget.retryAfterSeconds);
      }
      return d.subscriptions.consume(userId, 'coach');
    },
    giveBack: () => d.subscriptions.refund(userId, 'coach'),
  };
}

const guarded = [
  requireFeature('coach'),
  requireAuth,
  rateLimit({ name: 'coach', limit: 8, windowSeconds: 60, by: 'user' }),
  rateLimit({ name: 'coach-ip-day', limit: 200, windowSeconds: 86400, by: 'ip', strict: true }),
];

coachRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/coach/messages',
    tags: ['Coach'],
    summary: 'Ask Pango: a message to the coach and its reply',
    security: bearer,
    description:
      'The server keeps the conversation (90 days) and adds the person’s own goals and recent numbers. Uses the daily coach allowance (429 `quota_exceeded`), except for replies that need no model: helplines when someone may be in crisis, and requests Pango turns away. Show replies as plain text.',
    middleware: guarded,
    request: { body: jsonBody(askSchema) },
    responses: {
      200: json(askResultSchema, 'The reply'),
      502: commonErrors[400],
      503: commonErrors[400],
      ...authErrors,
    },
  }), // fmt: skip
  async (c) =>
    c.json(await c.get('deps').coach.ask(c.get('auth')!.userId, c.req.valid('json'), coachAllowance(c)), 200),
);

coachRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/coach/pantry-meals',
    tags: ['Coach'],
    summary: 'Meal ideas from the foods someone has at home',
    security: bearer,
    description:
      'The model only chooses recipes from the given foods (plus salt, pepper, herbs, spices, garlic, lemon, vinegar and water); the server checks every ingredient and works out the nutrition from the foods’ own figures, sized to the goal. Uses one unit of the daily coach allowance.',
    middleware: guarded,
    request: { body: jsonBody(pantryAskSchema) },
    responses: {
      200: json(pantryResultSchema, 'Up to three recipes'),
      502: commonErrors[400],
      503: commonErrors[400],
      ...authErrors,
    },
  }), // fmt: skip
  async (c) =>
    c.json(
      await c.get('deps').pantry.meals(c.get('auth')!.userId, c.req.valid('json'), coachAllowance(c)),
      200,
    ),
);

coachRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/admin/coach/eval',
    tags: ['Admin'],
    summary: 'Run the coach for a made-up person, saving nothing (red-team checks)',
    security: [{ adminKey: [] }],
    middleware: requireAdmin,
    request: { body: jsonBody(evalSchema) },
    responses: {
      200: json(evalResultSchema, 'What Pango would say'),
      401: commonErrors[400],
      502: commonErrors[400],
      503: commonErrors[400],
    },
  }), // fmt: skip
  async (c) => {
    const d = c.get('deps');
    const budget = await d.strictLimiter.hit('ai-budget', d.config.AI_DAILY_BUDGET, 86400);
    if (!budget.allowed) throw aiBudgetExceeded(budget.retryAfterSeconds);
    return c.json(await d.coach.evaluate(c.req.valid('json')), 200);
  },
);

coachRoutes.openapi(
  createRoute({
    method: 'get',
    path: '/coach/messages',
    tags: ['Coach'],
    summary: 'The conversation with Pango so far',
    security: bearer,
    middleware: [requireFeature('coach'), requireAuth],
    responses: { 200: json(historySchema, 'Messages, oldest first'), ...authErrors },
  }), // fmt: skip
  async (c) => c.json(await c.get('deps').coach.history(c.get('auth')!.userId), 200),
);

coachRoutes.openapi(
  createRoute({
    method: 'delete',
    path: '/coach/messages',
    tags: ['Coach'],
    summary: 'Start over: delete the conversation',
    security: bearer,
    middleware: [requireAuth],
    responses: { 204: { description: 'Deleted' }, ...authErrors },
  }), // fmt: skip
  async (c) => {
    await c.get('deps').coach.clear(c.get('auth')!.userId);
    return c.body(null, 204);
  },
);
