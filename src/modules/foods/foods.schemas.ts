import { z } from '../../core/openapi';
import { calories, clientIdSchema, grams, timestampSchema } from '../../core/schemas';
import { putResultSchema } from '../body/body.schemas';

const sodium = z.number().min(0).max(100000);

export const foodInputSchema = z
  .object({
    name: z.string().trim().min(1).max(200),
    brand: z.string().trim().max(100).nullable().optional(),
    barcode: z
      .string()
      .regex(/^\d{8,14}$/)
      .nullable()
      .optional(),
    servingG: z.number().positive().max(5000).nullable().optional(),
    servingLabel: z.string().trim().max(60).nullable().optional(),
    calories100g: calories.max(950),
    protein100g: grams.max(100),
    carb100g: grams.max(100),
    fat100g: grams.max(100),
    fiber100g: grams.max(100).nullable().optional(),
    sugar100g: grams.max(100).nullable().optional(),
    sodiumMg100g: sodium.nullable().optional(),
    clientUpdatedAt: timestampSchema,
  })
  .openapi('FoodInput');

const perServing = z
  .object({ calories: z.number(), proteinG: z.number(), carbG: z.number(), fatG: z.number() })
  .openapi('PerServing');

export const foodRecordSchema = z
  .object({
    id: clientIdSchema,
    source: z.enum(['custom', 'openfoodfacts', 'usda', 'curated']),
    isOwn: z.boolean().describe('A food the user created, which they can edit and delete'),
    barcode: z.string().nullable(),
    name: z.string(),
    brand: z.string().nullable(),
    servingG: z.number().nullable(),
    servingLabel: z.string().nullable(),
    calories100g: z.number(),
    protein100g: z.number(),
    carb100g: z.number(),
    fat100g: z.number(),
    fiber100g: z.number().nullable(),
    sugar100g: z.number().nullable(),
    sodiumMg100g: z.number().nullable(),
    perServing: perServing.nullable().describe('Present when the serving size in grams is known'),
    clientUpdatedAt: timestampSchema,
    updatedAt: timestampSchema,
    deletedAt: timestampSchema.nullable(),
    rev: z.number().int(),
  })
  .openapi('Food');

export const foodPutResultSchema = putResultSchema(foodRecordSchema, 'FoodPutResult');
export const foodListSchema = z.object({ items: z.array(foodRecordSchema) }).openapi('FoodList');

export const searchQuerySchema = z.object({
  q: z.string().trim().min(2).max(80),
  limit: z.coerce.number().int().min(1).max(50).default(25),
});

export const barcodeParamSchema = z.object({
  code: z.string().regex(/^\d{8,14}$/, 'Digits only, 8 to 14 long'),
});
