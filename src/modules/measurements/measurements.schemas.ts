import { z } from '../../core/openapi';
import { clientIdSchema, localDateSchema, timestampSchema } from '../../core/schemas';
import { putResultSchema } from '../body/body.schemas';

export const MEASUREMENT_TYPES = [
  'neck',
  'shoulders',
  'chest',
  'waist',
  'hips',
  'thigh',
  'arm',
  'calf',
  'body_fat',
] as const;
export type MeasurementType = (typeof MEASUREMENT_TYPES)[number];
export const measurementTypeSchema = z.enum(MEASUREMENT_TYPES);

/** Sensible bounds per type: tape measures in centimetres, body fat in percent. */
export const RANGES: Record<MeasurementType, { min: number; max: number; unit: 'cm' | '%' }> = {
  neck: { min: 15, max: 100, unit: 'cm' },
  shoulders: { min: 40, max: 200, unit: 'cm' },
  chest: { min: 40, max: 250, unit: 'cm' },
  waist: { min: 30, max: 300, unit: 'cm' },
  hips: { min: 40, max: 300, unit: 'cm' },
  thigh: { min: 15, max: 150, unit: 'cm' },
  arm: { min: 10, max: 100, unit: 'cm' },
  calf: { min: 10, max: 100, unit: 'cm' },
  body_fat: { min: 2, max: 70, unit: '%' },
};

export const measurementInputSchema = z
  .object({
    loggedAt: timestampSchema,
    localDate: localDateSchema,
    type: measurementTypeSchema,
    value: z.number().positive().describe('Centimetres, or percent for `body_fat`'),
    note: z.string().trim().max(500).nullable().optional(),
    clientUpdatedAt: timestampSchema,
  })
  .superRefine((v, ctx) => {
    const r = RANGES[v.type];
    if (v.value < r.min || v.value > r.max)
      ctx.addIssue({
        code: 'custom',
        path: ['value'],
        message: `A ${v.type.replace('_', ' ')} between ${r.min} and ${r.max} ${r.unit} is expected`,
      });
  })
  .openapi('MeasurementInput');

export const measurementRecordSchema = z
  .object({
    id: clientIdSchema,
    loggedAt: timestampSchema,
    localDate: localDateSchema,
    type: measurementTypeSchema,
    value: z.number(),
    unit: z.enum(['cm', '%']),
    note: z.string().nullable(),
    clientUpdatedAt: timestampSchema,
    updatedAt: timestampSchema,
    deletedAt: timestampSchema.nullable(),
    rev: z.number().int(),
  })
  .openapi('MeasurementRecord');

export const measurementPutResultSchema = putResultSchema(measurementRecordSchema, 'MeasurementPutResult');
export const measurementListSchema = z
  .object({ items: z.array(measurementRecordSchema) })
  .openapi('MeasurementList');
export const measurementQuerySchema = z
  .object({ from: localDateSchema, to: localDateSchema, type: measurementTypeSchema.optional() })
  .refine((r) => r.from <= r.to, { message: '`from` must not be after `to`', path: ['from'] });
