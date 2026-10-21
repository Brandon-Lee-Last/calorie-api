import { z } from '../../core/openapi';
import {
  slugSchema,
  equipmentSchema,
  goalSchema,
  levelSchema,
  muscleSchema,
  tierSchema,
  exerciseSchema,
} from '../workouts/workouts.schemas';

export const mediaKeySchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,99}$/, 'Lowercase letters, digits, dots, dashes and underscores');
export const keyParam = z.object({ key: mediaKeySchema });
export const adminSlugParam = z.object({ slug: slugSchema });

export const mediaInputSchema = z
  .object({
    kind: z.enum(['video', 'image', 'pdf']),
    provider: z.enum(['r2', 'stream', 'external']),
    location: z
      .string()
      .max(2000)
      .nullable()
      .optional()
      .describe(
        '`external`: an https URL. `stream`: the Stream video id. `r2`: leave empty and upload the file.',
      ),
    mime: z.string().max(100).nullable().optional(),
    durationS: z.number().int().min(0).max(86_400).nullable().optional(),
    width: z.number().int().min(1).max(20_000).nullable().optional(),
    height: z.number().int().min(1).max(20_000).nullable().optional(),
    title: z.string().trim().max(200).nullable().optional(),
    tier: tierSchema.default('free'),
  })
  .openapi('AdminMediaInput');

export const mediaRecordSchema = z
  .object({
    id: z.string(),
    key: z.string(),
    kind: z.enum(['video', 'image', 'pdf']),
    provider: z.enum(['r2', 'stream', 'external']),
    location: z.string().nullable(),
    mime: z.string().nullable(),
    bytes: z.number().int().nullable(),
    durationS: z.number().int().nullable(),
    title: z.string().nullable(),
    tier: tierSchema,
    uploaded: z.boolean().describe('For r2 media: the file has been uploaded'),
  })
  .openapi('AdminMedia');

export const exerciseInputSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    muscleGroups: z.array(muscleSchema).min(1).max(6),
    equipment: z.array(equipmentSchema).max(6).default([]),
    difficulty: levelSchema,
    instructions: z.string().max(10_000).default(''),
    tips: z.string().max(2000).nullable().optional(),
    imageMediaKey: z.string().nullable().optional(),
    videoMediaKey: z.string().nullable().optional(),
    source: z.string().max(300).nullable().optional(),
    licence: z.string().max(100).nullable().optional(),
  })
  .openapi('AdminExerciseInput');

const exerciseRef = z
  .object({
    exerciseSlug: slugSchema,
    sets: z.number().int().min(1).max(30),
    repsMin: z.number().int().min(1).max(1000).nullable().optional(),
    repsMax: z.number().int().min(1).max(1000).nullable().optional(),
    durationS: z.number().int().min(1).max(7200).nullable().optional(),
    restS: z.number().int().min(0).max(1800).nullable().optional(),
    notes: z.string().max(500).nullable().optional(),
  })
  .refine((e) => e.repsMin != null || e.durationS != null, {
    message: 'Give reps or a duration',
    path: ['repsMin'],
  })
  .refine((e) => e.repsMin == null || e.repsMax == null || e.repsMin <= e.repsMax, {
    message: 'repsMin must not exceed repsMax',
    path: ['repsMin'],
  });

const workoutInput = z.object({
  key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,39}$/),
  week: z.number().int().min(1).max(52),
  day: z.number().int().min(1).max(7),
  position: z.number().int().min(0).max(20).default(0),
  title: z.string().trim().min(1).max(120),
  notes: z.string().max(1000).nullable().optional(),
  estMinutes: z.number().int().min(1).max(300).nullable().optional(),
  tierOverride: tierSchema
    .nullable()
    .optional()
    .describe('Make one workout free inside a Pro program (a sample)'),
  exercises: z.array(exerciseRef).min(1).max(40),
});

export const programInputSchema = z
  .object({
    title: z.string().trim().min(1).max(120),
    summary: z.string().trim().min(1).max(300),
    description: z.string().max(20_000).default(''),
    level: levelSchema,
    goal: goalSchema,
    weeks: z.number().int().min(1).max(52),
    daysPerWeek: z.number().int().min(1).max(7),
    equipment: z.array(equipmentSchema).max(11).default([]),
    coverMediaKey: z.string().nullable().optional(),
    tier: tierSchema.default('free'),
    author: z.string().max(120).nullable().optional(),
    position: z.number().int().min(0).max(10_000).default(0),
    workouts: z.array(workoutInput).min(1).max(400),
  })
  .superRefine((p, ctx) => {
    const seen = new Set<string>();
    const slots = new Set<string>();
    p.workouts.forEach((w, i) => {
      if (seen.has(w.key))
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate workout key "${w.key}"`,
          path: ['workouts', i, 'key'],
        });
      seen.add(w.key);
      const slot = `${w.week}:${w.day}:${w.position}`;
      if (slots.has(slot))
        ctx.addIssue({
          code: 'custom',
          message: 'Two workouts share a week, day and position',
          path: ['workouts', i, 'position'],
        });
      slots.add(slot);
      if (w.week > p.weeks)
        ctx.addIssue({
          code: 'custom',
          message: `Week ${w.week} is beyond the program length of ${p.weeks}`,
          path: ['workouts', i, 'week'],
        });
    });
  })
  .openapi('AdminProgramInput');

export const adminProgramSchema = z
  .object({
    id: z.string(),
    slug: slugSchema,
    title: z.string(),
    tier: tierSchema,
    published: z.boolean(),
    workoutCount: z.number().int(),
    updatedAt: z.number().int(),
  })
  .openapi('AdminProgram');

export const adminProgramListSchema = z
  .object({ items: z.array(adminProgramSchema) })
  .openapi('AdminProgramList');

export const accuracyQuerySchema = z.object({ modelVersion: z.string().min(1).max(40).optional() });

export const accuracySchema = z
  .object({
    models: z.array(
      z.object({
        modelVersion: z.string(),
        scans: z.number().int(),
        notFood: z.number().int(),
        discarded: z.number().int(),
        kept: z.number().int().describe('Saved or edited'),
        editedShare: z
          .number()
          .nullable()
          .describe('Of the kept scans, the share the person changed after the portion adjustment'),
        meanCorrectionKcal: z
          .number()
          .nullable()
          .describe(
            'Mean absolute difference between what was kept and the prediction scaled by the chosen portion',
          ),
        meanSignedCorrectionKcal: z
          .number()
          .nullable()
          .describe('Negative when people usually lower the estimate (the model over-estimates)'),
        contributedPhotos: z.number().int(),
      }),
    ),
  })
  .openapi('ScanAccuracy');

export { exerciseSchema };

export const auditPageSchema = z
  .object({
    items: z.array(
      z.object({
        id: z.string(),
        at: z.number().int(),
        actor: z.string(),
        method: z.string(),
        path: z.string(),
        status: z.number().int(),
        requestId: z.string(),
      }),
    ),
    nextCursor: z.string().nullable(),
  })
  .openapi('AdminAuditPage');
