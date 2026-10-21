import { z } from 'zod';

/** Everything wrangler binds to the Worker: bindings, plain vars and secrets. */
export interface Bindings {
  DB: D1Database;
  MEDIA: R2Bucket;
  AI?: Ai;
  ENVIRONMENT: string;
  GOOGLE_CLIENT_IDS: string;
  BILLING_PROVIDER: string;
  AI_TEXT_MODEL: string;
  CORS_ORIGINS: string;
  SIMULATE_ENABLED: string;
  // secrets
  JWT_SECRET: string;
  MEDIA_SIGNING_SECRET: string;
  ADMIN_API_KEY: string;
  GOOGLE_PLAY_PACKAGE_NAME?: string;
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_PLAY_RTDN_AUDIENCE?: string;
  OFF_USER_AGENT?: string;
  AI_DAILY_BUDGET?: string;
  REQUIRE_INTEGRITY?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  // test only
  TEST_MIGRATIONS?: unknown;
}

const list = (s: string) =>
  s
    .split(',')
    .map((x) => x.trim())
    .filter(Boolean);

const schema = z.object({
  ENVIRONMENT: z.enum(['local', 'stage', 'production']),
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  MEDIA_SIGNING_SECRET: z.string().min(32, 'MEDIA_SIGNING_SECRET must be at least 32 characters'),
  ADMIN_API_KEY: z.string().min(24, 'ADMIN_API_KEY must be at least 24 characters'),
  GOOGLE_CLIENT_IDS: z.string().default('').transform(list),
  BILLING_PROVIDER: z.enum(['mock', 'google_play']).default('mock'),
  AI_TEXT_MODEL: z.string().min(1),
  CORS_ORIGINS: z.string().default('').transform(list),
  SIMULATE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  GOOGLE_PLAY_PACKAGE_NAME: z.string().optional(),
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GOOGLE_PLAY_RTDN_AUDIENCE: z.string().optional(),
  OFF_USER_AGENT: z.string().optional(),
  /** Most AI calls the whole service will make in a day, so a bug or an attack cannot run up the bill. */
  AI_DAILY_BUDGET: z.coerce.number().int().min(0).default(20000),
  RESEND_API_KEY: z.string().optional(),
  /** The From address for sign-in emails, e.g. `Calories <login@yourdomain.com>`. */
  EMAIL_FROM: z.string().optional(),
  /** `true` to demand Play Integrity proof when an account is created. Off until the Play project exists. */
  REQUIRE_INTEGRITY: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
});

export type Config = z.output<typeof schema> & { isProduction: boolean };

const cache = new WeakMap<object, Config>();

/**
 * Validate the Worker's vars and secrets once per isolate. A missing or weak secret fails loudly on the
 * first request instead of producing tokens signed with something guessable.
 */
export function getConfig(env: Bindings): Config {
  const hit = cache.get(env);
  if (hit) return hit;
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${problems}`);
  }
  const config: Config = { ...parsed.data, isProduction: parsed.data.ENVIRONMENT === 'production' };
  if (config.isProduction && config.SIMULATE_ENABLED) {
    throw new Error('Invalid configuration: SIMULATE_ENABLED must be false in production');
  }
  cache.set(env, config);
  return config;
}
