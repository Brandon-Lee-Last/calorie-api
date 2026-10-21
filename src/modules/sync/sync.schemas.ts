import { z } from '../../core/openapi';
import { clientIdSchema, timestampSchema } from '../../core/schemas';
import { entryRecordSchema } from '../diary/diary.schemas';
import { waterRecordSchema, weightRecordSchema } from '../body/body.schemas';
import { activityRecordSchema } from '../activity/activity.schemas';
import { measurementRecordSchema } from '../measurements/measurements.schemas';
import { progressRecordSchema } from '../progress/progress.schemas';
import { recipeRecordSchema } from '../recipes/recipes.schemas';
import { foodRecordSchema } from '../foods/foods.schemas';
import { sessionRecordSchema } from '../workouts/sessions.schemas';

export const SYNC_TYPES = [
  'diary_entry',
  'weight',
  'water',
  'food',
  'workout_session',
  'recipe',
  'activity',
  'measurement',
  'progress_photo',
] as const;
export const syncTypeSchema = z.enum(SYNC_TYPES);

export const changeSchema = z
  .discriminatedUnion('type', [
    z.object({ type: z.literal('diary_entry'), record: entryRecordSchema }),
    z.object({ type: z.literal('weight'), record: weightRecordSchema }),
    z.object({ type: z.literal('water'), record: waterRecordSchema }),
    z.object({ type: z.literal('food'), record: foodRecordSchema }),
    z.object({ type: z.literal('workout_session'), record: sessionRecordSchema }),
    z.object({ type: z.literal('recipe'), record: recipeRecordSchema }),
    z.object({ type: z.literal('activity'), record: activityRecordSchema }),
    z.object({ type: z.literal('measurement'), record: measurementRecordSchema }),
    z.object({ type: z.literal('progress_photo'), record: progressRecordSchema }),
  ])
  .openapi('SyncChange');

export const pullQuerySchema = z.object({
  since: z.coerce
    .number()
    .int()
    .min(0)
    .default(0)
    .describe('The `rev` from the previous pull (0 for the first one)'),
  limit: z.coerce.number().int().min(1).max(500).default(200),
});

export const pullResultSchema = z
  .object({
    changes: z
      .array(changeSchema)
      .describe('Oldest change first. A record with `deletedAt` set is a deletion.'),
    rev: z.number().int().describe('Store this and send it as `since` next time'),
    hasMore: z.boolean().describe('True when there are more changes: pull again straight away'),
  })
  .openapi('SyncPullResult');

export const pushOpSchema = z
  .object({
    type: syncTypeSchema,
    id: clientIdSchema,
    op: z.enum(['upsert', 'delete']),
    data: z
      .record(z.string(), z.unknown())
      .optional()
      .describe('For `upsert`: the same body as the matching PUT endpoint, including `clientUpdatedAt`'),
    clientUpdatedAt: timestampSchema
      .optional()
      .describe('For `delete`: when the person deleted it (defaults to now)'),
  })
  .openapi('SyncOp');

export const MAX_PUSH_OPS = 50;
export const pushBodySchema = z
  .object({ ops: z.array(pushOpSchema).min(1).max(MAX_PUSH_OPS) })
  .openapi('SyncPushRequest');

export const pushResultItemSchema = z
  .object({
    type: syncTypeSchema,
    id: z.string(),
    status: z.enum(['applied', 'stale', 'noop', 'error']),
    record: z
      .unknown()
      .optional()
      .describe('The server version after the op (for `stale`, the newer one that won)'),
    error: z.object({ code: z.string(), message: z.string(), details: z.unknown().optional() }).optional(),
  })
  .openapi('SyncOpResult');

export const pushResultSchema = z
  .object({ results: z.array(pushResultItemSchema) })
  .openapi('SyncPushResult');
