/**
 * Features that can be switched off from the admin API without a deploy (`disabledFeatures`). The API refuses requests for the
 * ones marked server-enforced; the rest are only reported by `GET /config` so the app can hide them.
 */
export const FEATURES = {
  aiText: { enforced: true, describe: 'AI meal text parsing' },
  emailSignIn: { enforced: true, describe: 'Sign in with an emailed code' },
  workouts: { enforced: false, describe: 'Workout programs' },
  scanContributions: { enforced: false, describe: 'Offering meal photos to improve the model' },
} as const;

export type FeatureName = keyof typeof FEATURES;
export const FEATURE_NAMES = Object.keys(FEATURES) as [FeatureName, ...FeatureName[]];
