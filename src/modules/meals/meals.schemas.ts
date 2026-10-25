import { z } from '../../core/openapi';
import { mealTypeSchema } from '../../core/schemas';
import { slugSchema, tierSchema } from '../workouts/workouts.schemas';

export const SLOTS = ['breakfast', 'lunch', 'dinner', 'snack'] as const;
export const GOAL_TYPES = ['lose', 'maintain', 'gain'] as const;
/** Where an ingredient is in a shop, to group a shopping list. */
export const AISLES = ['produce', 'meat-fish', 'dairy-eggs', 'bakery-grains', 'pantry', 'frozen'] as const;

const kcal = z.number().min(0).max(2500);
const g = z.number().min(0).max(400);
const text = (max: number) => z.string().trim().min(1).max(max);
const fraction = z.number().min(0).max(1);

export const dietInputSchema = z
  .object({
    title: text(60),
    summary: text(160),
    description: z.string().trim().max(2000).default(''),
    tier: tierSchema,
    position: z.number().int().min(0).max(1000).default(0),
    goals: z.array(z.enum(GOAL_TYPES)).min(1).max(3).describe('Goals this style suits'),
    highlights: z.array(text(80)).max(6).default([]),
    split: z
      .object({ breakfast: fraction, lunch: fraction, dinner: fraction, snack: fraction })
      .describe(
        "Share of the day's calories for each meal (a second snack, when there is one, halves the snack share)",
      )
      .refine(
        (s) => Math.abs(s.breakfast + s.lunch + s.dinner + s.snack - 1) <= 0.02,
        'The shares must add up to 1',
      ),
    macros: z
      .object({
        proteinPct: z.number().int().min(5).max(60),
        carbPct: z.number().int().min(5).max(75),
        fatPct: z.number().int().min(10).max(75),
      })
      .refine(
        (m) => Math.abs(m.proteinPct + m.carbPct + m.fatPct - 100) <= 2,
        'The percentages must add up to 100',
      )
      .describe('The rough energy split the meals aim for, shown as guidance'),
    caution: z
      .string()
      .trim()
      .max(400)
      .nullable()
      .default(null)
      .describe('Who should check with a health professional first'),
  })
  .openapi('AdminDietInput');

export const ingredientSchema = z
  .object({
    name: text(80),
    grams: z
      .number()
      .positive()
      .max(2000)
      .describe('Grams in one portion, as eaten (cooked where it says so)'),
    measure: z
      .string()
      .trim()
      .max(40)
      .nullable()
      .default(null)
      .describe('A kitchen measure for one portion, e.g. "½ cup"'),
    aisle: z.enum(AISLES).nullable().default(null),
  })
  .openapi('MealIngredient');

export const nutritionSchema = z
  .object({ calories: kcal, proteinG: g, carbG: g, fatG: g, fibreG: g.nullable().default(null) })
  .describe('One portion')
  .openapi('MealNutrition');

export const mealInputSchema = z
  .object({
    title: text(80),
    summary: z.string().trim().max(160).default(''),
    slots: z.array(mealTypeSchema).min(1).max(4).describe('Which meals of the day it can be'),
    diets: z.array(slugSchema).min(1).max(10),
    minutes: z.number().int().min(0).max(600),
    tags: z.array(slugSchema).max(8).default([]),
    ingredients: z.array(ingredientSchema).min(1).max(25),
    steps: z.array(text(400)).max(12).default([]),
    nutrition: nutritionSchema,
    source: z
      .string()
      .trim()
      .max(200)
      .nullable()
      .default(null)
      .describe('Where the nutrition numbers come from'),
  })
  .superRefine((m, ctx) => {
    if (new Set(m.slots).size !== m.slots.length)
      ctx.addIssue({ code: 'custom', path: ['slots'], message: 'A slot is listed twice' });
    // Catches a typo in the numbers: energy from the macros must be close to the calories given.
    const { calories, proteinG, carbG, fatG } = m.nutrition;
    const fromMacros = 4 * proteinG + 4 * carbG + 9 * fatG;
    if (Math.abs(fromMacros - calories) > Math.max(40, calories * 0.15))
      ctx.addIssue({
        code: 'custom',
        path: ['nutrition', 'calories'],
        message: `Calories (${calories}) do not match the macros (${Math.round(fromMacros)})`,
      });
  })
  .openapi('AdminMealInput');

export const dietSchema = z
  .object({
    slug: z.string(),
    title: z.string(),
    summary: z.string(),
    description: z.string(),
    tier: tierSchema,
    locked: z.boolean().describe('True for a Pro style on a free account'),
    goals: z.array(z.enum(GOAL_TYPES)),
    highlights: z.array(z.string()),
    split: z.object({ breakfast: z.number(), lunch: z.number(), dinner: z.number(), snack: z.number() }),
    macros: z.object({ proteinPct: z.number(), carbPct: z.number(), fatPct: z.number() }),
    caution: z.string().nullable(),
    mealCount: z.number().int(),
  })
  .openapi('Diet');

export const mealSchema = z
  .object({
    slug: z.string(),
    title: z.string(),
    summary: z.string(),
    slots: z.array(mealTypeSchema),
    diets: z.array(z.string()),
    minutes: z.number().int(),
    tags: z.array(z.string()),
    nutrition: nutritionSchema,
    locked: z
      .boolean()
      .describe('True when every diet it is in is Pro and the account is free: no ingredients or steps then'),
    ingredients: z.array(ingredientSchema),
    steps: z.array(z.string()),
    source: z.string().nullable(),
  })
  .openapi('Meal');

export const mealPlansSchema = z
  .object({
    diets: z.array(dietSchema).describe('In display order'),
    meals: z.array(mealSchema).describe('A to Z'),
    updatedAt: z
      .number()
      .int()
      .nullable()
      .describe('When the newest diet or meal was saved: keep the copy on the phone until it changes'),
  })
  .openapi('MealPlans');

export const adminMealPlansSchema = z
  .object({ diets: z.array(z.string()), meals: z.array(z.string()) })
  .openapi('AdminMealPlanSlugs');

export type DietInput = z.infer<typeof dietInputSchema>;
export type MealInput = z.infer<typeof mealInputSchema>;
