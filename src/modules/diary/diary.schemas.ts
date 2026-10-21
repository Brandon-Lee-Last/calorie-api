import { z } from '../../core/openapi';
import {
  calories,
  clientIdSchema,
  dateRangeQuery,
  grams,
  localDateSchema,
  mealTypeSchema,
  optionalGrams,
  timestampSchema,
} from '../../core/schemas'; // fmt: skip
import { putResultSchema } from '../body/body.schemas';

export const entrySourceSchema = z.enum(['scan', 'manual', 'food', 'barcode', 'ai_text', 'quick_add']);

export const entryInputSchema = z
  .object({
    loggedAt: timestampSchema,
    localDate: localDateSchema,
    mealType: mealTypeSchema,
    name: z.string().trim().min(1).max(200),
    foodId: clientIdSchema.nullable().optional(),
    quantityG: z.number().positive().max(10000).nullable().optional(),
    servings: z.number().positive().max(1000).nullable().optional(),
    calories,
    proteinG: grams.default(0),
    carbG: grams.default(0),
    fatG: grams.default(0),
    fiberG: optionalGrams.optional(),
    sugarG: optionalGrams.optional(),
    sodiumMg: z.number().min(0).max(100000).nullable().optional(),
    source: entrySourceSchema,
    scanId: clientIdSchema.nullable().optional(),
    note: z.string().trim().max(500).nullable().optional(),
    clientUpdatedAt: timestampSchema,
  })
  .openapi('DiaryEntryInput');

export const entryRecordSchema = z
  .object({
    id: clientIdSchema,
    loggedAt: timestampSchema,
    localDate: localDateSchema,
    mealType: mealTypeSchema,
    name: z.string(),
    foodId: z.string().nullable(),
    quantityG: z.number().nullable(),
    servings: z.number().nullable(),
    calories: z.number(),
    proteinG: z.number(),
    carbG: z.number(),
    fatG: z.number(),
    fiberG: z.number().nullable(),
    sugarG: z.number().nullable(),
    sodiumMg: z.number().nullable(),
    source: entrySourceSchema,
    scanId: z.string().nullable(),
    hasPhoto: z.boolean(),
    note: z.string().nullable(),
    clientUpdatedAt: timestampSchema,
    updatedAt: timestampSchema,
    deletedAt: timestampSchema.nullable(),
    rev: z.number().int(),
  })
  .openapi('DiaryEntry');

export const entryPutResultSchema = putResultSchema(entryRecordSchema, 'DiaryEntryPutResult');
export const entryListSchema = z.object({ items: z.array(entryRecordSchema) }).openapi('DiaryEntryList');

export const dayTotalsSchema = z
  .object({
    localDate: localDateSchema,
    entries: z.number().int(),
    calories: z.number(),
    proteinG: z.number(),
    carbG: z.number(),
    fatG: z.number(),
    fiberG: z.number(),
    sugarG: z.number(),
    sodiumMg: z.number(),
    waterMl: z.number().int(),
  })
  .openapi('DayTotals');
export const summarySchema = z.object({ days: z.array(dayTotalsSchema) }).openapi('DiarySummary');

export const recentFoodSchema = z
  .object({
    name: z.string(),
    mealType: mealTypeSchema,
    calories: z.number(),
    proteinG: z.number(),
    carbG: z.number(),
    fatG: z.number(),
    quantityG: z.number().nullable(),
    servings: z.number().nullable(),
    foodId: z.string().nullable(),
    lastLoggedAt: timestampSchema,
    timesLogged: z.number().int(),
  })
  .openapi('RecentFood');
export const recentListSchema = z.object({ items: z.array(recentFoodSchema) }).openapi('RecentFoodList');

export const recentQuerySchema = z.object({ limit: z.coerce.number().int().min(1).max(50).default(20) });
export { dateRangeQuery };
