import { z } from './openapi';
import { isClientId } from './ids';
import { isLocalDate } from './time';

/** Records are created on the phone, so their ids come from the phone: a ULID or a UUID. */
export const clientIdSchema = z
  .string()
  .refine(isClientId, 'Must be a ULID or UUID')
  .openapi({ description: 'Client-generated id (ULID or UUID)', example: '01J8Z3K6M4Q2W7X9R5T1V0BHNE' });

export const localDateSchema = z
  .string()
  .refine(isLocalDate, 'Must be a real date written YYYY-MM-DD')
  .openapi({ example: '2026-10-21', description: 'Calendar date in the user’s own timezone' });

export const timestampSchema = z
  .number()
  .int()
  .min(0)
  .max(4_102_444_800_000)
  .openapi({ description: 'Milliseconds since the Unix epoch' });

export const mealTypeSchema = z.enum(['breakfast', 'lunch', 'dinner', 'snack']);

/** Calorie and macro amounts for one logged item or food. */
export const calories = z.number().min(0).max(20000);
export const grams = z.number().min(0).max(5000);
export const optionalGrams = grams.nullable();

export const idParam = z.object({ id: clientIdSchema });

export const dateRangeQuery = z
  .object({ from: localDateSchema, to: localDateSchema })
  .refine((r) => r.from <= r.to, { message: '`from` must not be after `to`', path: ['from'] });
