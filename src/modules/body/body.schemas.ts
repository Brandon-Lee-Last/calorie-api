import { z } from '../../core/openapi';
import { clientIdSchema, localDateSchema, timestampSchema } from '../../core/schemas';

export const weightInputSchema = z
  .object({
    loggedAt: timestampSchema,
    localDate: localDateSchema,
    weightKg: z.number().min(20).max(400),
    note: z.string().trim().max(500).nullable().optional(),
    clientUpdatedAt: timestampSchema,
  })
  .openapi('WeightInput');

export const weightRecordSchema = z
  .object({
    id: clientIdSchema,
    loggedAt: timestampSchema,
    localDate: localDateSchema,
    weightKg: z.number(),
    note: z.string().nullable(),
    clientUpdatedAt: timestampSchema,
    updatedAt: timestampSchema,
    deletedAt: timestampSchema.nullable(),
    rev: z.number().int(),
  })
  .openapi('WeightRecord');

export const waterInputSchema = z
  .object({
    loggedAt: timestampSchema,
    localDate: localDateSchema,
    ml: z.number().int().min(1).max(5000),
    clientUpdatedAt: timestampSchema,
  })
  .openapi('WaterInput');

export const waterRecordSchema = z
  .object({
    id: clientIdSchema,
    loggedAt: timestampSchema,
    localDate: localDateSchema,
    ml: z.number().int(),
    clientUpdatedAt: timestampSchema,
    updatedAt: timestampSchema,
    deletedAt: timestampSchema.nullable(),
    rev: z.number().int(),
  })
  .openapi('WaterRecord');

export const putResultSchema = <T extends z.ZodType>(record: T, name: string) =>
  z
    .object({
      applied: z
        .boolean()
        .describe(
          'False when the server already holds a newer edit of this record; `record` is then the server version',
        ),
      record,
    })
    .openapi(name);

export const weightListSchema = z.object({ items: z.array(weightRecordSchema) }).openapi('WeightList');
export const waterListSchema = z
  .object({
    items: z.array(waterRecordSchema),
    totalsByDate: z.record(z.string(), z.number().int()).describe('Millilitres per local date'),
  })
  .openapi('WaterList');
