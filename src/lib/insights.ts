import { addDays, dateRange } from '../core/time';

export type DayTotals = {
  localDate: string;
  entries: number;
  calories: number;
  proteinG: number;
  carbG: number;
  fatG: number;
  waterMl: number;
};

const r1 = (n: number) => Math.round(n * 10) / 10;
const r0 = Math.round;

/**
 * How many days in a row, ending at `end`, have at least one logged meal. If nothing is logged on `end` yet, the streak
 * is counted up to the day before, so someone is not told they lost it before the day is over.
 */
export function streakDays(logged: Set<string>, end: string, maxLookback = 365): number {
  let day = logged.has(end) ? end : addDays(end, -1);
  let n = 0;
  while (logged.has(day) && n < maxLookback) {
    n++;
    day = addDays(day, -1);
  }
  return n;
}

/** Fill in the days with nothing logged, so a week always has seven rows. */
export function fillDays(from: string, to: string, have: DayTotals[]): DayTotals[] {
  const by = new Map(have.map((d) => [d.localDate, d]));
  return dateRange(from, to).map(
    (localDate) =>
      by.get(localDate) ?? { localDate, entries: 0, calories: 0, proteinG: 0, carbG: 0, fatG: 0, waterMl: 0 },
  );
}

export type WeekSummary = {
  daysLogged: number;
  avgCalories: number | null;
  avgProteinG: number | null;
  avgCarbG: number | null;
  avgFatG: number | null;
  avgWaterMl: number | null;
  calorieGoal: number;
  /** Days with a logged total within 10% of the goal. */
  daysOnTarget: number;
  /** Average against goal as a percentage difference (+8 means 8% above), or null with nothing logged. */
  avgVsGoalPct: number | null;
};

/** Averages are over the days something was logged: a day with no entries is "not logged", not "ate nothing". */
export function summarizeWeek(days: DayTotals[], calorieGoal: number): WeekSummary {
  const logged = days.filter((d) => d.entries > 0);
  const avg = (f: (d: DayTotals) => number) =>
    logged.length ? r1(logged.reduce((s, d) => s + f(d), 0) / logged.length) : null;
  const avgCalories = avg((d) => d.calories);
  const waterDays = days.filter((d) => d.waterMl > 0);
  return {
    daysLogged: logged.length,
    avgCalories: avgCalories === null ? null : r0(avgCalories),
    avgProteinG: avg((d) => d.proteinG),
    avgCarbG: avg((d) => d.carbG),
    avgFatG: avg((d) => d.fatG),
    avgWaterMl: waterDays.length ? r0(waterDays.reduce((s, d) => s + d.waterMl, 0) / waterDays.length) : null,
    calorieGoal,
    daysOnTarget: logged.filter((d) => Math.abs(d.calories - calorieGoal) <= 0.1 * calorieGoal).length,
    avgVsGoalPct:
      avgCalories === null || calorieGoal <= 0 ? null : r1(((avgCalories - calorieGoal) / calorieGoal) * 100),
  };
}

export type WeightChange = { startKg: number; endKg: number; changeKg: number };

export function weightChange(
  logs: { localDate: string; loggedAt: number; weightKg: number }[],
): WeightChange | null {
  if (logs.length < 2) return null;
  const sorted = [...logs].sort((a, b) => a.localDate.localeCompare(b.localDate) || a.loggedAt - b.loggedAt);
  const startKg = sorted[0]!.weightKg;
  const endKg = sorted[sorted.length - 1]!.weightKg;
  return { startKg, endKg, changeKg: r1(endKg - startKg) };
}

/** Plain, neutral sentences about the numbers. No advice and no judgement. */
export function highlights(input: {
  summary: WeekSummary;
  streak: number;
  weight: WeightChange | null;
  trainingSessions: number;
}): string[] {
  const { summary: s } = input;
  const out: string[] = [];
  if (s.daysLogged === 0) return ['No meals were logged this week.'];
  out.push(`You logged meals on ${s.daysLogged} of 7 days.`);
  if (s.avgVsGoalPct !== null && s.avgCalories !== null) {
    if (Math.abs(s.avgVsGoalPct) <= 10) out.push('Your average was close to your daily goal.');
    else
      out.push(
        `You averaged ${Math.abs(Math.round(s.avgCalories - s.calorieGoal))} kcal ${s.avgVsGoalPct > 0 ? 'above' : 'below'} your daily goal.`,
      );
  }
  if (input.streak >= 3) out.push(`That is a ${input.streak} day logging streak.`);
  if (s.avgWaterMl !== null && s.avgWaterMl >= 1500)
    out.push(`You averaged ${r1(s.avgWaterMl / 1000)} L of water on the days you logged it.`);
  if (input.trainingSessions > 0)
    out.push(`You finished ${input.trainingSessions} workout${input.trainingSessions === 1 ? '' : 's'}.`);
  if (input.weight)
    out.push(
      `Your logged weight changed by ${input.weight.changeKg > 0 ? '+' : ''}${input.weight.changeKg} kg.`,
    );
  return out;
}
