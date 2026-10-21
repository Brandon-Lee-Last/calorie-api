import { z } from '../../core/openapi';

export const CATALOGUE_SOURCES = ['usda', 'curated', 'openfoodfacts'] as const;
/** D1 takes at most 100 bound values per statement and the Workers free plan allows few queries, so batches stay small. */
export const MAX_IMPORT = 100;

const optionalNumber = (max: number) => z.number().min(0).max(max).nullable().optional();

/** One food to put in the shared catalogue. Every number is per 100 g. */
export const catalogueFoodSchema = z.object({
  source: z.enum(CATALOGUE_SOURCES),
  externalId: z
    .string()
    .trim()
    .min(1)
    .max(80)
    .describe('Stable id in the source (`fdc:171077`, `safoods:0123`). Re-importing updates in place.'),
  name: z.string().trim().min(1).max(200),
  brand: z.string().trim().max(100).nullable().optional(),
  barcode: z
    .string()
    .regex(/^\d{8,14}$/)
    .nullable()
    .optional(),
  servingG: z.number().gt(0).max(5000).nullable().optional(),
  servingLabel: z.string().trim().max(60).nullable().optional(),
  calories100g: z.number().min(0).max(900),
  protein100g: z.number().min(0).max(100),
  carb100g: z.number().min(0).max(100),
  fat100g: z.number().min(0).max(100),
  fiber100g: optionalNumber(100),
  sugar100g: optionalNumber(100),
  sodiumMg100g: optionalNumber(40000),
  dishId: z
    .string()
    .regex(/^[a-z0-9_]{2,60}$/)
    .nullable()
    .optional()
    .describe('The dish this describes, from the model’s dish list'),
  aliases: z
    .array(z.string().trim().min(1).max(80))
    .max(10)
    .optional()
    .describe('Other names people search by'),
}); // fmt: skip
export type CatalogueFood = z.infer<typeof catalogueFoodSchema>;

export const importBodySchema = z
  .object({
    foods: z.array(z.unknown()).min(1).max(MAX_IMPORT),
    dryRun: z.boolean().default(false).describe('Check everything and report, but change nothing'),
  })
  .openapi('FoodImportRequest');

export const importResultSchema = z
  .object({
    created: z.number().int(),
    updated: z.number().int(),
    rejected: z.array(
      z.object({ index: z.number().int(), externalId: z.string().nullable(), reason: z.string() }),
    ),
    warnings: z.array(z.object({ index: z.number().int(), externalId: z.string(), message: z.string() })),
    dryRun: z.boolean(),
  })
  .openapi('FoodImportResult');

export const retireParamSchema = z.object({ id: z.string().min(8).max(40) });
