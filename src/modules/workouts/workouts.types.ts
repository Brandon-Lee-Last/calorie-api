export const LEVELS = ['beginner', 'intermediate', 'advanced'] as const;
export const GOALS = ['strength', 'muscle', 'fat_loss', 'endurance', 'mobility', 'general'] as const;
export const TIERS = ['free', 'pro'] as const;
export const MUSCLES = [
  'chest',
  'back',
  'lats',
  'traps',
  'lower_back',
  'shoulders',
  'biceps',
  'triceps',
  'forearms',
  'abs',
  'obliques',
  'glutes',
  'quads',
  'hamstrings',
  'calves',
  'full_body',
  'cardio',
] as const; // fmt: skip
export const EQUIPMENT = [
  'bodyweight',
  'dumbbell',
  'barbell',
  'kettlebell',
  'machine',
  'cable',
  'bands',
  'bench',
  'pull_up_bar',
  'cardio_machine',
  'other',
] as const; // fmt: skip

export type Level = (typeof LEVELS)[number];
export type Goal = (typeof GOALS)[number];
export type Tier = (typeof TIERS)[number];
export type Muscle = (typeof MUSCLES)[number];
export type Equipment = (typeof EQUIPMENT)[number];

export const SLUG_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
