/**
 * Rough energy cost of exercise. Pure functions, no I/O.
 *
 * METs (metabolic equivalents) are how many times resting energy an activity uses. The values below are round, mid-range
 * figures in the spirit of the Compendium of Physical Activities (Ainsworth et al.). Real effort varies a lot between
 * people, so everything computed from them is an ESTIMATE and is marked as one; the person can always type their own number.
 */
export const ACTIVITY_KINDS = [
  'walking',
  'running',
  'cycling',
  'swimming',
  'strength',
  'yoga',
  'hiit',
  'sport',
  'steps',
  'other',
] as const; // fmt: skip
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** `null`: no sensible estimate (steps are counted, not timed; "other" could be anything). */
export const MET: Record<ActivityKind, number | null> = {
  walking: 3.5,
  running: 9.8,
  cycling: 7.5,
  swimming: 6,
  strength: 5,
  yoga: 2.5,
  hiit: 8,
  sport: 7,
  steps: null,
  other: null,
};

/** Used when the person has not told us their weight: a round adult figure, not a claim about anyone. */
export const DEFAULT_WEIGHT_KG = 70;

/** kcal = MET x weight (kg) x hours. Returns null where there is nothing sound to estimate from. */
export function estimateCalories(
  kind: ActivityKind,
  durationMin: number | null,
  weightKg: number | null,
): number | null {
  const met = MET[kind];
  if (met === null || durationMin === null || durationMin <= 0) return null;
  return Math.round(met * (weightKg ?? DEFAULT_WEIGHT_KG) * (durationMin / 60));
}
