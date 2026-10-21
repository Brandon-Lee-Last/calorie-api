/**
 * Calorie and macro goals. Pure functions, no I/O.
 *
 * These are population formulas that give a sensible starting point, not medical advice. Users can overwrite every
 * number.
 */

export type Sex = 'female' | 'male';
export type ActivityLevel = 'sedentary' | 'light' | 'moderate' | 'active' | 'very_active';
export type GoalType = 'lose' | 'maintain' | 'gain';

export const ACTIVITY_FACTOR: Record<ActivityLevel, number> = {
  sedentary: 1.2,
  light: 1.375,
  moderate: 1.55,
  active: 1.725,
  very_active: 1.9,
};

/** Energy in a kilogram of body-weight change, the usual rule of thumb. */
export const KCAL_PER_KG = 7700;

/** Never recommend less than this (kcal/day), whatever the weekly target says. */
export const CALORIE_FLOOR: Record<Sex | 'unspecified', number> = {
  female: 1200,
  male: 1500,
  unspecified: 1200,
};

export const MAX_RATE_KG_PER_WEEK = 1;

export const MACRO_SPLIT: Record<GoalType, { protein: number; carb: number; fat: number }> = {
  lose: { protein: 0.3, carb: 0.4, fat: 0.3 },
  maintain: { protein: 0.25, carb: 0.45, fat: 0.3 },
  gain: { protein: 0.25, carb: 0.5, fat: 0.25 },
};

export type GoalInputs = {
  sex: Sex | null;
  birthYear: number;
  heightCm: number;
  weightKg: number;
  activityLevel: ActivityLevel;
  goal: GoalType;
  /** Signed weekly change in kg. Ignored (treated as 0) for `maintain`; sign is forced to match `goal`. */
  rateKgPerWeek: number;
};

export type Goals = { calories: number; proteinG: number; carbG: number; fatG: number };

export type GoalRecommendation = Goals & {
  bmr: number;
  tdee: number;
  /** True when the weekly target asked for less than the safety floor and the floor was used instead. */
  floorApplied: boolean;
};

export const DEFAULT_GOALS: Goals = { calories: 2000, proteinG: 125, carbG: 225, fatG: 67 };

export function ageOn(birthYear: number, nowMs: number): number {
  return new Date(nowMs).getUTCFullYear() - birthYear;
}

/** Mifflin-St Jeor. Without a recorded sex the two constants are averaged. */
export function bmr(sex: Sex | null, weightKg: number, heightCm: number, ageYears: number): number {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * ageYears;
  const constant = sex === 'male' ? 5 : sex === 'female' ? -161 : (5 - 161) / 2;
  return base + constant;
}

export function macroGrams(calories: number, goal: GoalType): Pick<Goals, 'proteinG' | 'carbG' | 'fatG'> {
  const s = MACRO_SPLIT[goal];
  return {
    proteinG: Math.round((calories * s.protein) / 4),
    carbG: Math.round((calories * s.carb) / 4),
    fatG: Math.round((calories * s.fat) / 9),
  };
}

export function recommendGoals(input: GoalInputs, nowMs: number): GoalRecommendation {
  const age = ageOn(input.birthYear, nowMs);
  const bmrValue = bmr(input.sex, input.weightKg, input.heightCm, age);
  const tdee = bmrValue * ACTIVITY_FACTOR[input.activityLevel];

  let rate = input.goal === 'maintain' ? 0 : input.rateKgPerWeek;
  if (input.goal === 'lose') rate = -Math.abs(rate);
  if (input.goal === 'gain') rate = Math.abs(rate);
  rate = Math.max(-MAX_RATE_KG_PER_WEEK, Math.min(MAX_RATE_KG_PER_WEEK, rate));

  const wanted = tdee + (rate * KCAL_PER_KG) / 7;
  const floor = CALORIE_FLOOR[input.sex ?? 'unspecified'];
  const floorApplied = wanted < floor;
  const calories = Math.round(Math.max(wanted, floor) / 10) * 10;
  return {
    calories,
    ...macroGrams(calories, input.goal),
    bmr: Math.round(bmrValue),
    tdee: Math.round(tdee),
    floorApplied,
  };
}

/** Calories from macros, the way nutrition labels do it. */
export function caloriesFromMacros(proteinG: number, carbG: number, fatG: number): number {
  return Math.round(proteinG * 4 + carbG * 4 + fatG * 9);
}

export const kgToLb = (kg: number) => kg * 2.2046226218;
export const lbToKg = (lb: number) => lb / 2.2046226218;
export const cmToIn = (cm: number) => cm / 2.54;
export const inToCm = (inches: number) => inches * 2.54;
