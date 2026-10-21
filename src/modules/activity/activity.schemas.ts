import { ACTIVITY_KINDS } from '../../lib/activity';
import { z } from '../../core/openapi';
import { clientIdSchema, localDateSchema, timestampSchema } from '../../core/schemas';
import { putResultSchema } from '../body/body.schemas';

export const activityKindSchema = z.enum(ACTIVITY_KINDS);

export const activityInputSchema = z
  .object({
    loggedAt: timestampSchema,
    localDate: localDateSchema,
    kind: activityKindSchema.describe(
      '`steps` is a day’s step count from the phone; every other kind needs `durationMin`',
    ),
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .nullable()
      .optional()
      .describe('For `sport` and `other`: what it was'),
    durationMin: z.number().min(1).max(1440).nullable().optional(),
    steps: z.number().int().min(1).max(200000).nullable().optional(),
    distanceKm: z.number().min(0).max(1000).nullable().optional(),
    caloriesBurned: z
      .number()
      .min(0)
      .max(20000)
      .nullable()
      .optional()
      .describe('Leave out to have the server estimate it from the kind, duration and the person’s weight'),
    note: z.string().trim().max(500).nullable().optional(),
    clientUpdatedAt: timestampSchema,
  })
  .superRefine((v, ctx) => {
    if (v.kind === 'steps') {
      if (!v.steps)
        ctx.addIssue({ code: 'custom', path: ['steps'], message: 'A steps entry needs the step count' });
    } else if (!v.durationMin) {
      ctx.addIssue({ code: 'custom', path: ['durationMin'], message: 'How long it lasted is needed' });
    }
  })
  .openapi('ActivityInput');

export const activityRecordSchema = z
  .object({
    id: clientIdSchema,
    loggedAt: timestampSchema,
    localDate: localDateSchema,
    kind: activityKindSchema,
    name: z.string().nullable(),
    durationMin: z.number().nullable(),
    steps: z.number().int().nullable(),
    distanceKm: z.number().nullable(),
    caloriesBurned: z.number().nullable(),
    caloriesEstimated: z
      .boolean()
      .describe('True when the server worked the calories out; show them as approximate'),
    note: z.string().nullable(),
    clientUpdatedAt: timestampSchema,
    updatedAt: timestampSchema,
    deletedAt: timestampSchema.nullable(),
    rev: z.number().int(),
  })
  .openapi('ActivityRecord');

export const activityPutResultSchema = putResultSchema(activityRecordSchema, 'ActivityPutResult');

export const activityListSchema = z
  .object({
    items: z.array(activityRecordSchema),
    totalsByDate: z.record(
      z.string(),
      z.object({ minutes: z.number(), caloriesBurned: z.number(), steps: z.number().int() }),
    ),
  })
  .openapi('ActivityList');
