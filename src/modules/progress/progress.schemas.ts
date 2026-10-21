import { z } from '../../core/openapi';
import { clientIdSchema, dateRangeQuery, localDateSchema, timestampSchema } from '../../core/schemas';
import { putResultSchema } from '../body/body.schemas';

export const poseSchema = z.enum(['front', 'side', 'back', 'other']);

export const progressInputSchema = z
  .object({
    loggedAt: timestampSchema,
    localDate: localDateSchema,
    pose: poseSchema,
    weightKg: z
      .number()
      .min(20)
      .max(400)
      .nullable()
      .optional()
      .describe('Weight on the day, to show next to the photo'),
    note: z.string().trim().max(500).nullable().optional(),
    clientUpdatedAt: timestampSchema,
  })
  .openapi('ProgressPhotoInput');

export const progressRecordSchema = z
  .object({
    id: clientIdSchema,
    loggedAt: timestampSchema,
    localDate: localDateSchema,
    pose: poseSchema,
    weightKg: z.number().nullable(),
    note: z.string().nullable(),
    hasPhoto: z.boolean(),
    clientUpdatedAt: timestampSchema,
    updatedAt: timestampSchema,
    deletedAt: timestampSchema.nullable(),
    rev: z.number().int(),
  })
  .openapi('ProgressPhotoRecord');

export const progressPutResultSchema = putResultSchema(progressRecordSchema, 'ProgressPhotoPutResult');
export const progressListSchema = z
  .object({ items: z.array(progressRecordSchema) })
  .openapi('ProgressPhotoList');
export { dateRangeQuery };
