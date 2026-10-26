import { FEATURE_NAMES } from '../../config/features';
import { z } from '../../core/openapi';

const version = z
  .string()
  .regex(/^\d{1,6}\.\d{1,6}(\.\d{1,6})?$/, 'Use a version like 1.4.0')
  .openapi({ example: '1.4.0' });

export const settingsSchema = z
  .object({
    maintenance: z.object({ enabled: z.boolean(), message: z.string() }),
    minAppVersion: z.string(),
    latestAppVersion: z.string(),
    disabledFeatures: z.array(z.enum(FEATURE_NAMES)),
  })
  .openapi('AppSettings');

export const settingsPatchSchema = z
  .object({
    maintenance: z
      .object({ enabled: z.boolean(), message: z.string().trim().min(1).max(300).nullable().optional() })
      .nullable()
      .optional()
      .describe('`null` goes back to the deploy’s setting'),
    minAppVersion: version.nullable().optional().describe('Older apps get 426 `upgrade_required`'),
    latestAppVersion: version.nullable().optional().describe('Older apps are told an update is available'),
    disabledFeatures: z.array(z.enum(FEATURE_NAMES)).max(20).nullable().optional(),
  })
  .strict()
  .openapi('AppSettingsPatch');

export const publicConfigSchema = z
  .object({
    apiVersion: z.literal('v1'),
    serverTime: z.number().int().describe('Milliseconds since 1970, for spotting a wrong phone clock'),
    maintenance: z.object({ enabled: z.boolean(), message: z.string() }),
    update: z
      .enum(['unknown', 'none', 'available', 'required'])
      .describe('For the app version sent in `x-app-version`; `unknown` when the header is missing'),
    minAppVersion: z.string(),
    latestAppVersion: z.string(),
    features: z.record(z.string(), z.boolean()).describe('false means switched off right now'),
    signIn: z.object({ google: z.boolean(), email: z.boolean() }),
    integrity: z.object({ required: z.boolean() }),
    testPurchases: z
      .boolean()
      .describe(
        'A test server: `POST /subscription/simulate` works, so the app may offer to try Plus. Never true in production',
      ),
    urls: z.object({
      store: z.string().nullable(),
      privacy: z.string().nullable(),
      terms: z.string().nullable(),
      supportEmail: z.string().nullable(),
    }),
    plans: z.record(
      z.string(),
      z.object({
        limits: z.object({
          scansPerDay: z.number(),
          aiTextPerDay: z.number(),
          coachPerDay: z.number(),
          mealPhotos: z.number(),
          recipes: z.number(),
          progressPhotos: z.number(),
        }),
        features: z.object({ workouts: z.string(), insights: z.string(), export: z.boolean() }),
      }),
    ),
  })
  .openapi('PublicConfig');
