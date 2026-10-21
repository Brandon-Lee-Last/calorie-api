/**
 * What each plan includes. One place, so changing a limit is one edit.
 *
 * The numbers are PLACEHOLDERS for a product decision. `scansPerDay` is advisory: scanning runs on the phone, so the
 * server can only count and report it, and the app enforces it. Everything else here is enforced by the API.
 */
export type PlanId = 'free' | 'pro';

export type PlanLimits = {
  /** On-device photo scans per day. Advisory (the app enforces it). */
  scansPerDay: number;
  /** AI text meal logging calls per day. */
  aiTextPerDay: number;
  /** Meal photos kept on the server. */
  mealPhotos: number;
  /** Saved recipes. */
  recipes: number;
  /** Progress photos kept on the server. */
  progressPhotos: number;
};

export type Plan = {
  id: PlanId;
  limits: PlanLimits;
  features: { workouts: 'free' | 'all'; insights: 'basic' | 'full'; export: boolean };
};

export const UNLIMITED = 1_000_000;

/**
 * Accounts nobody has signed in to (no Google or email linked) are the cheapest thing to mass-produce, so they get a
 * smaller AI allowance. Linking a sign-in method raises it to the plan's normal limit.
 */
export const ANONYMOUS_AI_TEXT_PER_DAY = 2;

export const PLANS: Record<PlanId, Plan> = {
  free: {
    id: 'free',
    limits: { scansPerDay: 3, aiTextPerDay: 5, mealPhotos: 30, recipes: 10, progressPhotos: 12 },
    features: { workouts: 'free', insights: 'basic', export: true },
  },
  pro: {
    id: 'pro',
    limits: {
      scansPerDay: UNLIMITED,
      aiTextPerDay: 100,
      mealPhotos: UNLIMITED,
      recipes: UNLIMITED,
      progressPhotos: UNLIMITED,
    },
    features: { workouts: 'all', insights: 'full', export: true },
  },
};

export const USAGE_KEYS = ['scan', 'ai_text'] as const;
export type UsageKey = (typeof USAGE_KEYS)[number];

/** Which limit applies to which counter. */
export const LIMIT_FOR_KEY: Record<UsageKey, keyof PlanLimits> = {
  scan: 'scansPerDay',
  ai_text: 'aiTextPerDay',
};

export const PRODUCTS = [
  { id: 'pro_monthly', plan: 'pro' as const, period: 'P1M', trialDays: 7 },
  { id: 'pro_yearly', plan: 'pro' as const, period: 'P1Y', trialDays: 7 },
] as const;
export type ProductId = (typeof PRODUCTS)[number]['id'];
export const isProductId = (s: string): s is ProductId => PRODUCTS.some((p) => p.id === s);
