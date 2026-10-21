import { describe, expect, it } from 'vitest';
import {
  ACTIVITY_FACTOR,
  CALORIE_FLOOR,
  DEFAULT_GOALS,
  ageOn,
  bmr,
  caloriesFromMacros,
  cmToIn,
  inToCm,
  kgToLb,
  lbToKg,
  macroGrams,
  recommendGoals,
  type GoalInputs,
} from './nutrition';

const NOW = Date.UTC(2026, 5, 1);
const base: GoalInputs = {
  sex: 'male',
  birthYear: 1996, // 30 in 2026
  heightCm: 180,
  weightKg: 80,
  activityLevel: 'moderate',
  goal: 'maintain',
  rateKgPerWeek: 0,
};

describe('bmr', () => {
  it('matches Mifflin-St Jeor for a 30 year old, 180 cm, 80 kg man (1780 kcal)', () => {
    expect(bmr('male', 80, 180, 30)).toBe(1780);
  });
  it('matches it for a 30 year old, 165 cm, 60 kg woman (1320.25 kcal)', () => {
    expect(bmr('female', 60, 165, 30)).toBeCloseTo(1320.25, 5);
  });
  it('averages the constants when sex is unknown', () => {
    const m = bmr('male', 70, 170, 40);
    const f = bmr('female', 70, 170, 40);
    expect(bmr(null, 70, 170, 40)).toBeCloseTo((m + f) / 2, 8);
  });
  it('age comes from the birth year', () => {
    expect(ageOn(1996, NOW)).toBe(30);
  });
});

describe('recommendGoals', () => {
  it('maintenance is BMR times the activity factor, rounded to 10', () => {
    const r = recommendGoals(base, NOW);
    expect(r.bmr).toBe(1780);
    expect(r.tdee).toBe(Math.round(1780 * ACTIVITY_FACTOR.moderate)); // 2759
    expect(r.calories).toBe(2760);
    expect(r.floorApplied).toBe(false);
  });
  it('losing 0.5 kg a week takes about 550 kcal a day off', () => {
    const r = recommendGoals({ ...base, goal: 'lose', rateKgPerWeek: 0.5 }, NOW);
    expect(r.calories).toBe(Math.round((1780 * 1.55 - 550) / 10) * 10); // 2210
    expect(r.calories).toBe(2210);
  });
  it('treats the sign of the rate as the goal decides', () => {
    expect(recommendGoals({ ...base, goal: 'lose', rateKgPerWeek: -0.5 }, NOW).calories).toBe(2210);
    expect(recommendGoals({ ...base, goal: 'lose', rateKgPerWeek: 0.5 }, NOW).calories).toBe(2210);
    expect(recommendGoals({ ...base, goal: 'gain', rateKgPerWeek: -0.25 }, NOW).calories).toBe(
      Math.round((1780 * 1.55 + 275) / 10) * 10,
    );
    expect(recommendGoals({ ...base, goal: 'maintain', rateKgPerWeek: 0.9 }, NOW).calories).toBe(2760);
  });
  it('caps the weekly rate at 1 kg', () => {
    const capped = recommendGoals({ ...base, goal: 'gain', rateKgPerWeek: 5 }, NOW).calories;
    const one = recommendGoals({ ...base, goal: 'gain', rateKgPerWeek: 1 }, NOW).calories;
    expect(capped).toBe(one);
  });
  it('never goes below the safety floor and says so', () => {
    const small = recommendGoals(
      {
        sex: 'female',
        birthYear: 1970,
        heightCm: 150,
        weightKg: 45,
        activityLevel: 'sedentary',
        goal: 'lose',
        rateKgPerWeek: 1,
      },
      NOW,
    );
    expect(small.calories).toBe(CALORIE_FLOOR.female);
    expect(small.floorApplied).toBe(true);
    const man = recommendGoals(
      {
        sex: 'male',
        birthYear: 1960,
        heightCm: 160,
        weightKg: 50,
        activityLevel: 'sedentary',
        goal: 'lose',
        rateKgPerWeek: 1,
      },
      NOW,
    );
    expect(man.calories).toBe(CALORIE_FLOOR.male);
  });
  it('macros add up to the calories, within rounding', () => {
    for (const goal of ['lose', 'maintain', 'gain'] as const) {
      const r = recommendGoals({ ...base, goal, rateKgPerWeek: 0.5 }, NOW);
      expect(Math.abs(caloriesFromMacros(r.proteinG, r.carbG, r.fatG) - r.calories)).toBeLessThanOrEqual(10);
    }
  });
  it('splits protein higher when losing', () => {
    const lose = macroGrams(2000, 'lose');
    const maintain = macroGrams(2000, 'maintain');
    expect(lose.proteinG).toBeGreaterThan(maintain.proteinG);
    expect(maintain).toEqual({ proteinG: 125, carbG: 225, fatG: 67 });
  });
  it('the default goals are a 2000 kcal maintain split', () => {
    expect(DEFAULT_GOALS).toEqual({ calories: 2000, ...macroGrams(2000, 'maintain') });
  });
});

describe('units', () => {
  it('converts both ways', () => {
    expect(kgToLb(1)).toBeCloseTo(2.2046, 3);
    expect(lbToKg(kgToLb(73.5))).toBeCloseTo(73.5, 8);
    expect(cmToIn(2.54)).toBe(1);
    expect(inToCm(70)).toBeCloseTo(177.8, 8);
  });
});
