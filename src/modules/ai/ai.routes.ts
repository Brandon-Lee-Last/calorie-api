import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import type { AppEnv } from '../../app-types';
import { authErrors, bearer, commonErrors, json, jsonBody, z } from '../../core/openapi';
import { requireAuth } from '../../middleware/auth';
import { rateLimit } from '../../middleware/rate-limit';

export const aiRoutes = new OpenAPIHono<AppEnv>();

const bodySchema = z
  .object({
    text: z
      .string()
      .trim()
      .min(3)
      .max(500)
      .openapi({ example: 'two slices of toast with peanut butter and a coffee with milk' }),
  })
  .openapi('ParseMealRequest');
const itemSchema = z
  .object({
    name: z.string(),
    quantityText: z.string(),
    quantityG: z.number().nullable(),
    calories: z.number(),
    proteinG: z.number(),
    carbG: z.number(),
    fatG: z.number(),
    confidence: z.enum(['low', 'medium', 'high']),
    energyMismatch: z.boolean().describe('Calories and macros disagree by more than a third: show a warning'),
  })
  .openapi('ParsedMealItem');
const resultSchema = z
  .object({
    items: z.array(itemSchema),
    estimate: z
      .literal(true)
      .describe('Always true. These are guesses for the person to confirm or correct, not measurements.'),
    usage: z.object({ used: z.number().int(), limit: z.number().int() }),
  })
  .openapi('ParseMealResult');

aiRoutes.openapi(
  createRoute({
    method: 'post',
    path: '/ai/parse-meal',
    tags: ['AI'],
    summary: 'Turn a typed meal description into estimated food items',
    security: bearer,
    description:
      'Counts against the daily AI allowance (429 `quota_exceeded` when it is used up; a failed call is not charged). Show the items for the person to confirm, edit and save as diary entries with source `ai_text`.',
    middleware: [requireAuth, rateLimit({ name: 'ai', limit: 20, windowSeconds: 60, by: 'user' })],
    request: { body: jsonBody(bodySchema) },
    responses: {
      200: json(resultSchema, 'Estimated items'),
      502: commonErrors[400],
      501: commonErrors[400],
      ...authErrors,
    },
  }), // fmt: skip
  async (c) => {
    const d = c.get('deps');
    const userId = c.get('auth')!.userId;
    const usage = await d.subscriptions.consume(userId, 'ai_text');
    try {
      const result = await d.ai.parseMeal(c.req.valid('json').text);
      return c.json({ ...result, usage }, 200);
    } catch (e) {
      await d.subscriptions.refund(userId, 'ai_text'); // a failed attempt does not use up the allowance
      throw e;
    }
  },
);
