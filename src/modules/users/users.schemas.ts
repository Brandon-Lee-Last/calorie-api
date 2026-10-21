import { z } from '../../core/openapi';

export const unitsSchema = z.enum(['metric', 'imperial']);
export const sexSchema = z.enum(['female', 'male']);
export const activitySchema = z.enum(['sedentary', 'light', 'moderate', 'active', 'very_active']);
export const goalTypeSchema = z.enum(['lose', 'maintain', 'gain']);

export const goalsSchema = z
  .object({
    calories: z.number().int().min(800).max(10000),
    proteinG: z.number().int().min(0).max(1500),
    carbG: z.number().int().min(0).max(1500),
    fatG: z.number().int().min(0).max(1500),
  })
  .openapi('GoalsInput');

export const goalsResponseSchema = goalsSchema
  .extend({ custom: z.boolean().describe('Set by the user, so it is not recalculated') })
  .openapi('Goals');

export const profileSchema = z
  .object({
    timezone: z.string(),
    locale: z.string(),
    units: unitsSchema,
    sex: sexSchema.nullable(),
    birthYear: z.number().int().nullable(),
    heightCm: z.number().nullable(),
    weightKg: z.number().nullable(),
    activityLevel: activitySchema.nullable(),
    goal: goalTypeSchema,
    goalRateKgPerWeek: z.number(),
    targetWeightKg: z.number().nullable(),
    onboardedAt: z.number().int().nullable(),
    goals: goalsResponseSchema,
  })
  .openapi('Profile');

export const profilePatchSchema = z
  .object({
    timezone: z.string().min(1).max(64),
    locale: z
      .string()
      .max(16)
      .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/),
    units: unitsSchema,
    sex: sexSchema.nullable(),
    birthYear: z.number().int().min(1900).max(2100).nullable(),
    heightCm: z.number().min(50).max(260).nullable(),
    weightKg: z.number().min(20).max(400).nullable(),
    activityLevel: activitySchema.nullable(),
    goal: goalTypeSchema,
    goalRateKgPerWeek: z.number().min(-1).max(1),
    targetWeightKg: z.number().min(20).max(400).nullable(),
    onboarded: z.boolean().describe('Mark onboarding finished (true) or not (false)'),
  })
  .partial()
  .openapi('ProfilePatch');

export const meSchema = z
  .object({
    id: z.string(),
    createdAt: z.number().int(),
    displayName: z.string().nullable(),
    email: z.string().nullable(),
    isAnonymous: z.boolean(),
    providers: z.array(z.literal('google')),
    profile: profileSchema,
  })
  .openapi('Me');

export const mePatchSchema = z
  .object({ displayName: z.string().trim().min(1).max(80).nullable() })
  .openapi('MePatch');

export const recommendationSchema = z
  .object({
    calories: z.number().int(),
    proteinG: z.number().int(),
    carbG: z.number().int(),
    fatG: z.number().int(),
    bmr: z.number().int(),
    tdee: z.number().int(),
    floorApplied: z.boolean(),
  })
  .openapi('GoalRecommendation');
