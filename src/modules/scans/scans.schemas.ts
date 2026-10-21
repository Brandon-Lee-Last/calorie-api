import { z } from '../../core/openapi';
import { calories, clientIdSchema, grams, timestampSchema } from '../../core/schemas';

const nutritionSchema = z
  .object({ calories, massG: grams, fatG: grams, carbG: grams, proteinG: grams })
  .openapi('ScanNutrition');

export const scanInputSchema = z
  .object({
    modelVersion: z.string().trim().min(1).max(40).openapi({ example: 'nutrition_v1' }),
    foodProbability: z.number().min(0).max(1).nullable().optional(),
    predicted: nutritionSchema
      .nullable()
      .optional()
      .describe('What the model said (absent for a photo that was rejected as not food)'),
    outcome: z.enum(['saved', 'edited', 'discarded', 'not_food']),
    final: nutritionSchema
      .nullable()
      .optional()
      .describe('What the person ended up saving, after any portion change or correction'),
    portion: z.number().positive().max(20).nullable().optional(),
    contributeConsent: z
      .boolean()
      .default(false)
      .describe('The person agreed to let this photo be used to improve the model'),
    clientCreatedAt: timestampSchema,
  })
  .openapi('ScanInput');

export const scanRecordSchema = z
  .object({
    id: clientIdSchema,
    modelVersion: z.string(),
    foodProbability: z.number().nullable(),
    predicted: nutritionSchema.nullable(),
    outcome: z.enum(['saved', 'edited', 'discarded', 'not_food']),
    final: nutritionSchema.nullable(),
    portion: z.number().nullable(),
    contributeConsent: z.boolean(),
    hasContributedPhoto: z.boolean(),
    clientCreatedAt: timestampSchema,
    createdAt: timestampSchema,
  })
  .openapi('Scan');
