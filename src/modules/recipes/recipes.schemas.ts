import { z } from '../../core/openapi';
import { calories, clientIdSchema, grams, timestampSchema } from '../../core/schemas';
import { putResultSchema } from '../body/body.schemas';

export const MAX_INGREDIENTS = 60;

export const ingredientSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    foodId: clientIdSchema
      .nullable()
      .optional()
      .describe('The food this came from, if it was picked from the food list'),
    quantityG: z.number().positive().max(50000).nullable().optional(),
    calories: calories.describe('For the quantity used in the whole recipe, not per 100 g'),
    proteinG: grams.default(0),
    carbG: grams.default(0),
    fatG: grams.default(0),
  })
  .openapi('RecipeIngredient');

export const recipeInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    servings: z.number().positive().max(100).describe('How many servings the recipe makes'),
    ingredients: z.array(ingredientSchema).min(1).max(MAX_INGREDIENTS),
    instructions: z.string().trim().max(5000).nullable().optional(),
    prepMinutes: z.number().int().min(0).max(1440).nullable().optional(),
    clientUpdatedAt: timestampSchema,
  })
  .openapi('RecipeInput');

const macros = z.object({ calories: z.number(), proteinG: z.number(), carbG: z.number(), fatG: z.number() });

export const recipeRecordSchema = z
  .object({
    id: clientIdSchema,
    name: z.string(),
    servings: z.number(),
    ingredients: z.array(ingredientSchema),
    totals: macros.describe('The whole recipe'),
    perServing: macros,
    instructions: z.string().nullable(),
    prepMinutes: z.number().int().nullable(),
    clientUpdatedAt: timestampSchema,
    updatedAt: timestampSchema,
    deletedAt: timestampSchema.nullable(),
    rev: z.number().int(),
  })
  .openapi('Recipe');

export const recipePutResultSchema = putResultSchema(recipeRecordSchema, 'RecipePutResult');

export const recipeListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(300).optional(),
});
export const recipeListSchema = z
  .object({ items: z.array(recipeRecordSchema), nextCursor: z.string().nullable() })
  .openapi('RecipeList');
