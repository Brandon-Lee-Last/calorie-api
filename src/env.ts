import { z } from 'zod';
import { isValidIpRule } from './lib/ip';

/** Everything wrangler binds to the Worker: bindings, plain vars and secrets. */
export interface Bindings {
  DB: D1Database;
  MEDIA: R2Bucket;
  AI?: Ai;
  ENVIRONMENT: string;
  GOOGLE_CLIENT_IDS: string;
  BILLING_PROVIDER: string;
  AI_TEXT_MODEL: string;
  AI_COACH_MODEL?: string;
  AI_GUARD_MODEL?: string;
  CORS_ORIGINS: string;
  SIMULATE_ENABLED: string;
  // secrets
  JWT_SECRET: string;
  JWT_SECRET_PREVIOUS?: string;
  ADMIN_ALLOWED_IPS?: string;
  CF_ACCESS_TEAM_DOMAIN?: string;
  CF_ACCESS_AUD?: string;
  ALERT_WEBHOOK_URL?: string;
  FCM_PROJECT_ID?: string;
  STREAM_CUSTOMER_CODE?: string;
  STREAM_SIGNING_KEY_ID?: string;
  STREAM_SIGNING_KEY_PEM?: string;
  FCM_SERVICE_ACCOUNT_JSON?: string;
  MEDIA_SIGNING_SECRET: string;
  ADMIN_API_KEY: string;
  GOOGLE_PLAY_PACKAGE_NAME?: string;
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON?: string;
  GOOGLE_PLAY_RTDN_AUDIENCE?: string;
  GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT?: string;
  OFF_USER_AGENT?: string;
  AI_DAILY_BUDGET?: string;
  REQUIRE_INTEGRITY?: string;
  RESEND_API_KEY?: string;
  EMAIL_FROM?: string;
  MIN_APP_VERSION?: string;
  LATEST_APP_VERSION?: string;
  MAINTENANCE_MODE?: string;
  MAINTENANCE_MESSAGE?: string;
  STORE_URL?: string;
  PRIVACY_URL?: string;
  TERMS_URL?: string;
  SUPPORT_EMAIL?: string;
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
  JWT_SECRET_PREVIOUS: z.string().min(32, 'JWT_SECRET_PREVIOUS must be at least 32 characters').optional(),
  /** Comma separated IPs or IPv4 ranges (`203.0.113.0/24`) allowed to call /admin. Empty means anywhere (the admin key is still needed). */
  ADMIN_ALLOWED_IPS: z
    .string()
    .default('')
    .transform(list)
    .refine(
      (l) => l.every(isValidIpRule),
      'ADMIN_ALLOWED_IPS has an entry that is not an IP address or range',
    ),
  /** Your Cloudflare Zero Trust team domain, e.g. `yourteam.cloudflareaccess.com`. With CF_ACCESS_AUD, /admin also requires an Access login. */
  CF_ACCESS_TEAM_DOMAIN: z
    .string()
    .regex(
      /^[a-z0-9.-]+\.[a-z]{2,}$/i,
      'CF_ACCESS_TEAM_DOMAIN must be a host name like yourteam.cloudflareaccess.com',
    )
    .optional(),
  CF_ACCESS_AUD: z.string().min(16).optional(),
  /** Cloudflare Stream signed playback: the customer code from your Stream player URLs and a signing key created for the account. */
  STREAM_CUSTOMER_CODE: z
    .string()
    .regex(/^[a-z0-9]{8,40}$/)
    .optional(),
  STREAM_SIGNING_KEY_ID: z
    .string()
    .regex(/^[a-f0-9]{16,64}$/)
    .optional(),
  STREAM_SIGNING_KEY_PEM: z.string().min(100).optional(),
  /** Firebase project id and a service account key (JSON) allowed to send messages, for push reminders. */
  FCM_PROJECT_ID: z
    .string()
    .regex(/^[a-z0-9-]{4,40}$/)
    .optional(),
  FCM_SERVICE_ACCOUNT_JSON: z.string().optional(),
  /** Slack, Discord or any URL that accepts a JSON POST. Gets a message when the API hits an unexpected error. */
  ALERT_WEBHOOK_URL: z
    .string()
    .url()
    .refine((u) => u.startsWith('https://'), 'ALERT_WEBHOOK_URL must be https')
    .optional(),
  MEDIA_SIGNING_SECRET: z.string().min(32, 'MEDIA_SIGNING_SECRET must be at least 32 characters'),
  ADMIN_API_KEY: z.string().min(24, 'ADMIN_API_KEY must be at least 24 characters'),
  GOOGLE_CLIENT_IDS: z.string().default('').transform(list),
  BILLING_PROVIDER: z.enum(['mock', 'google_play']).default('mock'),
  AI_TEXT_MODEL: z.string().min(1),
  // The coach needs a bigger model than meal parsing; the guard is Meta's Llama Guard safety classifier.
  AI_COACH_MODEL: z.string().min(1).default('@cf/meta/llama-3.3-70b-instruct-fp8-fast'),
  AI_GUARD_MODEL: z.string().min(1).default('@cf/meta/llama-guard-3-8b'),
  CORS_ORIGINS: z.string().default('').transform(list),
  SIMULATE_ENABLED: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  GOOGLE_PLAY_PACKAGE_NAME: z.string().optional(),
  GOOGLE_PLAY_SERVICE_ACCOUNT_JSON: z.string().optional(),
  GOOGLE_PLAY_RTDN_AUDIENCE: z.string().optional(),
  /** Email of the service account the Pub/Sub push subscription signs as. */
  GOOGLE_PLAY_RTDN_SERVICE_ACCOUNT: z.string().email().optional(),
  OFF_USER_AGENT: z.string().optional(),
  /** Most AI calls the whole service will make in a day, so a bug or an attack cannot run up the bill. */
  AI_DAILY_BUDGET: z.coerce.number().int().min(0).default(20000),
  RESEND_API_KEY: z.string().optional(),
  /** Oldest app version still allowed to use the API ("1.4.0"). Older ones get 426 `upgrade_required`. Admin settings override it. */
  MIN_APP_VERSION: z
    .string()
    .regex(/^\d+\.\d+(\.\d+)?$/, 'MIN_APP_VERSION must look like 1.4.0')
    .optional(),
  LATEST_APP_VERSION: z
    .string()
    .regex(/^\d+\.\d+(\.\d+)?$/, 'LATEST_APP_VERSION must look like 1.4.0')
    .optional(),
  /** `true` to start in maintenance mode from the deploy. The admin setting overrides it. */
  MAINTENANCE_MODE: z
    .enum(['true', 'false'])
    .default('false')
    .transform((v) => v === 'true'),
  MAINTENANCE_MESSAGE: z.string().max(300).optional(),
  STORE_URL: z.string().url().optional(),
  PRIVACY_URL: z.string().url().optional(),
  TERMS_URL: z.string().url().optional(),
  SUPPORT_EMAIL: z.string().email().optional(),
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
  if (Boolean(config.CF_ACCESS_TEAM_DOMAIN) !== Boolean(config.CF_ACCESS_AUD)) {
    throw new Error('Invalid configuration: CF_ACCESS_TEAM_DOMAIN and CF_ACCESS_AUD must be set together');
  }
  const stream = [config.STREAM_CUSTOMER_CODE, config.STREAM_SIGNING_KEY_ID, config.STREAM_SIGNING_KEY_PEM];
  if (stream.some(Boolean) && !stream.every(Boolean)) {
    throw new Error(
      'Invalid configuration: STREAM_CUSTOMER_CODE, STREAM_SIGNING_KEY_ID and STREAM_SIGNING_KEY_PEM must be set together',
    );
  }
  cache.set(env, config);
  return config;
}
