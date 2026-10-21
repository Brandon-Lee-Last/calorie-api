import { z } from '../../core/openapi';
import { localDateSchema } from '../../core/schemas';

const totals = z.object({ calories: z.number(), proteinG: z.number(), carbG: z.number(), fatG: z.number() });

export const overviewSchema = z
  .object({
    date: localDateSchema.describe('Today, in the person’s own timezone'),
    streakDays: z.number().int(),
    loggedToday: z.boolean(),
    today: totals.extend({ waterMl: z.number().int(), entries: z.number().int() }),
    goals: z.object({ calories: z.number(), proteinG: z.number(), carbG: z.number(), fatG: z.number() }),
  })
  .openapi('InsightsOverview');

export const weeklyQuerySchema = z.object({
  end: localDateSchema.optional().describe('Last day of the week to look at (default: today)'),
  narrative: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true')
    .describe('Pro: add a short written summary'),
});

export const weeklySchema = z
  .object({
    range: z.object({ from: localDateSchema, to: localDateSchema }),
    plan: z.enum(['free', 'pro']),
    days: z.array(
      totals.extend({ localDate: localDateSchema, entries: z.number().int(), waterMl: z.number().int() }),
    ),
    summary: z.object({
      daysLogged: z.number().int(),
      avgCalories: z.number().nullable(),
      avgProteinG: z.number().nullable().describe('Pro'),
      avgCarbG: z.number().nullable().describe('Pro'),
      avgFatG: z.number().nullable().describe('Pro'),
      avgWaterMl: z.number().nullable().describe('Pro'),
      calorieGoal: z.number(),
      daysOnTarget: z.number().int(),
      avgVsGoalPct: z.number().nullable(),
    }),
    streakDays: z.number().int(),
    weight: z
      .object({ startKg: z.number(), endKg: z.number(), changeKg: z.number() })
      .nullable()
      .describe('Pro'),
    training: z.object({ sessions: z.number().int(), minutes: z.number().int() }).nullable().describe('Pro'),
    previousWeek: z
      .object({ daysLogged: z.number().int(), avgCalories: z.number().nullable() })
      .nullable()
      .describe('Pro'),
    highlights: z.array(z.string()),
    narrative: z
      .string()
      .nullable()
      .describe('Pro, only when asked for. Words written from the numbers above.'),
  })
  .openapi('WeeklyInsights');
