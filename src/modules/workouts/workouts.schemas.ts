import { z } from '../../core/openapi';
import { clientIdSchema, timestampSchema } from '../../core/schemas';
import { EQUIPMENT, GOALS, LEVELS, MUSCLES, SLUG_RE, TIERS } from './workouts.types';

export const slugSchema = z.string().max(80).regex(SLUG_RE, 'Lowercase letters, digits and single hyphens');
export const levelSchema = z.enum(LEVELS);
export const goalSchema = z.enum(GOALS);
export const tierSchema = z.enum(TIERS);
export const muscleSchema = z.enum(MUSCLES);
export const equipmentSchema = z.enum(EQUIPMENT);

export const exerciseSchema = z
  .object({
    slug: slugSchema,
    name: z.string(),
    muscleGroups: z.array(muscleSchema),
    equipment: z.array(equipmentSchema),
    difficulty: levelSchema,
    instructions: z.string().describe('Markdown'),
    tips: z.string().nullable(),
    imageMediaId: z.string().nullable(),
    videoMediaId: z.string().nullable(),
    source: z.string().nullable().describe('Where the content comes from, for credit'),
    licence: z.string().nullable(),
  })
  .openapi('Exercise');

export const exerciseListSchema = z
  .object({ items: z.array(exerciseSchema), nextCursor: z.string().nullable() })
  .openapi('ExerciseList');

export const exerciseQuerySchema = z.object({
  q: z.string().trim().min(1).max(80).optional(),
  muscle: muscleSchema.optional(),
  equipment: equipmentSchema.optional(),
  difficulty: levelSchema.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().max(512).optional(),
});

export const programSummarySchema = z
  .object({
    id: clientIdSchema,
    slug: slugSchema,
    title: z.string(),
    summary: z.string(),
    level: levelSchema,
    goal: goalSchema,
    weeks: z.number().int(),
    daysPerWeek: z.number().int(),
    equipment: z.array(equipmentSchema),
    coverMediaId: z.string().nullable(),
    tier: tierSchema,
    author: z.string().nullable(),
    workoutCount: z.number().int(),
    locked: z
      .boolean()
      .describe('Pro content and this account is on the free plan (sample workouts may still be open)'),
  })
  .openapi('ProgramSummary');

export const programListSchema = z.object({ items: z.array(programSummarySchema) }).openapi('ProgramList');
export const programQuerySchema = z.object({
  level: levelSchema.optional(),
  goal: goalSchema.optional(),
  tier: tierSchema.optional(),
});

const workoutOutlineSchema = z
  .object({
    id: clientIdSchema,
    key: z.string(),
    title: z.string(),
    estMinutes: z.number().int().nullable(),
    exerciseCount: z.number().int(),
    tier: tierSchema,
    locked: z.boolean(),
  })
  .openapi('WorkoutOutline');

export const programDetailSchema = programSummarySchema
  .extend({
    description: z.string().describe('Markdown'),
    schedule: z.array(
      z.object({
        week: z.number().int(),
        days: z.array(z.object({ day: z.number().int(), workouts: z.array(workoutOutlineSchema) })),
      }),
    ),
  })
  .openapi('ProgramDetail');

export const workoutDetailSchema = z
  .object({
    id: clientIdSchema,
    key: z.string(),
    programSlug: slugSchema,
    programTitle: z.string(),
    week: z.number().int(),
    day: z.number().int(),
    title: z.string(),
    notes: z.string().nullable(),
    estMinutes: z.number().int().nullable(),
    tier: tierSchema,
    exercises: z.array(
      z.object({
        position: z.number().int(),
        exercise: exerciseSchema,
        sets: z.number().int(),
        repsMin: z.number().int().nullable(),
        repsMax: z.number().int().nullable(),
        durationS: z.number().int().nullable(),
        restS: z.number().int().nullable(),
        notes: z.string().nullable(),
      }),
    ),
  })
  .openapi('WorkoutDetail');

export const enrollmentSchema = z
  .object({
    program: programSummarySchema,
    status: z.enum(['active', 'completed', 'left']),
    startedAt: timestampSchema,
    progress: z.object({
      completedWorkouts: z.number().int(),
      totalWorkouts: z.number().int(),
      nextWorkout: workoutOutlineSchema.extend({ week: z.number().int(), day: z.number().int() }).nullable(),
    }),
  })
  .openapi('Enrollment');

export const currentEnrollmentSchema = z
  .object({ enrollment: enrollmentSchema.nullable() })
  .openapi('CurrentEnrollment');
export const slugParam = z.object({ slug: slugSchema });
export const workoutIdParam = z.object({ id: clientIdSchema });
