import { z } from '../../core/openapi';
import { clientIdSchema, localDateSchema, timestampSchema } from '../../core/schemas';
import { putResultSchema } from '../body/body.schemas';
import { slugSchema } from './workouts.schemas';

export const setLogSchema = z
  .object({
    exercise: slugSchema.describe('Exercise slug'),
    setNo: z.number().int().min(1).max(100),
    reps: z.number().int().min(0).max(1000).nullable().optional(),
    weightKg: z.number().min(0).max(1000).nullable().optional(),
    durationS: z.number().int().min(0).max(86_400).nullable().optional(),
    distanceM: z.number().min(0).max(1_000_000).nullable().optional(),
    rpe: z.number().min(1).max(10).nullable().optional().describe('Rate of perceived exertion'),
  })
  .openapi('SetLog');

export const sessionInputSchema = z
  .object({
    workoutId: clientIdSchema.nullable().optional(),
    programId: clientIdSchema.nullable().optional(),
    title: z.string().trim().min(1).max(120),
    startedAt: timestampSchema,
    finishedAt: timestampSchema.nullable().optional(),
    localDate: localDateSchema,
    sets: z.array(setLogSchema).max(300),
    notes: z.string().trim().max(1000).nullable().optional(),
    rating: z.number().int().min(1).max(5).nullable().optional(),
    caloriesBurned: z.number().min(0).max(10_000).nullable().optional(),
    clientUpdatedAt: timestampSchema,
  })
  .openapi('WorkoutSessionInput');

export const sessionRecordSchema = z
  .object({
    id: clientIdSchema,
    workoutId: z.string().nullable(),
    programId: z.string().nullable(),
    title: z.string(),
    startedAt: timestampSchema,
    finishedAt: timestampSchema.nullable(),
    localDate: localDateSchema,
    sets: z.array(setLogSchema),
    notes: z.string().nullable(),
    rating: z.number().int().nullable(),
    caloriesBurned: z.number().nullable(),
    clientUpdatedAt: timestampSchema,
    updatedAt: timestampSchema,
    deletedAt: timestampSchema.nullable(),
    rev: z.number().int(),
  })
  .openapi('WorkoutSession');

export const sessionPutResultSchema = putResultSchema(sessionRecordSchema, 'WorkoutSessionPutResult');
export const sessionListSchema = z
  .object({ items: z.array(sessionRecordSchema) })
  .openapi('WorkoutSessionList');

export const statsSchema = z
  .object({
    sessions: z.number().int(),
    minutes: z.number().int(),
    sets: z.number().int(),
    volumeKg: z.number().describe('Sum of reps x weight over all sets'),
    byDate: z.record(z.string(), z.number().int()).describe('Finished sessions per local date'),
  })
  .openapi('WorkoutStats');
