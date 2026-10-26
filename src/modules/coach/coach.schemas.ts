import { z } from '../../core/openapi';
import { slugSchema } from '../workouts/workouts.schemas';
import { clientIdSchema, mealTypeSchema } from '../../core/schemas';
import { MAX_MESSAGE } from './coach.service';
import { MAX_PANTRY } from './pantry';

export const coachMessageSchema = z
  .object({
    id: z.string(),
    role: z.enum(['user', 'assistant']),
    content: z.string().describe('Plain text: show it as text, never as markdown or HTML'),
    kind: z
      .enum(['chat', 'crisis', 'scope', 'blocked'])
      .describe(
        'For replies: chat (an answer), crisis (helplines), scope (a request Pango does not take), blocked (an answer replaced for safety)',
      ),
    createdAt: z.number().int(),
  })
  .openapi('CoachMessage');

export const askSchema = z
  .object({
    message: z.string().min(1).max(MAX_MESSAGE),
    planStyle: slugSchema
      .nullable()
      .optional()
      .describe('The meal plan style picked on the phone, so Pango can mention it'),
  })
  .openapi('CoachAsk');

export const askResultSchema = z
  .object({
    message: coachMessageSchema.describe('What was sent, as stored'),
    reply: coachMessageSchema,
    usage: z
      .object({ used: z.number().int(), limit: z.number().int() })
      .nullable()
      .describe(
        'The day’s allowance after this message; null when the reply did not use any (helplines, a refused request)',
      ),
  })
  .openapi('CoachAskResult');

export const pantryAskSchema = z
  .object({
    foodIds: z
      .array(clientIdSchema)
      .min(2)
      .max(MAX_PANTRY)
      .describe('Foods the person has (their own or from the food list)'),
    mealType: mealTypeSchema,
    calories: z
      .number()
      .int()
      .min(100)
      .max(2000)
      .nullable()
      .optional()
      .describe('Calories to aim for; else their goal’s share for that meal'),
  })
  .openapi('PantryMealsAsk');

export const pantryResultSchema = z
  .object({
    recipes: z.array(
      z.object({
        title: z.string(),
        minutes: z.number().int(),
        mealType: mealTypeSchema,
        ingredients: z.array(
          z.object({
            name: z.string(),
            grams: z.number(),
            foodId: z.string().nullable().describe('null for a staple such as salt'),
            calories: z
              .number()
              .int()
              .describe('This ingredient at these grams, from its own figures; 0 for a staple'),
          }),
        ),
        steps: z
          .array(z.string())
          .describe('How to make it; amounts are in `ingredients`, never in the steps'),
        nutrition: z
          .object({ calories: z.number(), proteinG: z.number(), carbG: z.number(), fatG: z.number() })
          .describe('One portion, worked out from the foods’ own figures'),
      }),
    ),
    target: z.number().int(),
    usage: z.object({ used: z.number().int(), limit: z.number().int() }),
  })
  .openapi('PantryMeals');

export const evalSchema = z
  .object({
    message: z.string().min(1).max(MAX_MESSAGE),
    age: z.number().int().min(10).max(100).nullable().optional(),
    entries: z
      .array(z.string().max(200))
      .max(6)
      .optional()
      .describe('Made-up diary entry names, to test instructions hidden in data'),
  })
  .openapi('CoachEval');
export const evalResultSchema = z
  .object({
    reply: z.string(),
    kind: z.enum(['chat', 'crisis', 'scope', 'blocked']),
    flags: z.array(z.string()),
  })
  .openapi('CoachEvalResult');

export const historySchema = z
  .object({ items: z.array(coachMessageSchema).describe('Oldest first, up to 60') })
  .openapi('CoachHistory');
