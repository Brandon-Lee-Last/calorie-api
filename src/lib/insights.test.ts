import { describe, expect, it } from 'vitest';
import { fillDays, highlights, streakDays, summarizeWeek, weightChange, type DayTotals } from './insights';

const day = (localDate: string, calories: number, over: Partial<DayTotals> = {}): DayTotals => ({
  localDate,
  entries: calories > 0 ? 2 : 0,
  calories,
  proteinG: calories / 20,
  carbG: calories / 10,
  fatG: calories / 40,
  waterMl: 0,
  ...over,
}); // fmt: skip

describe('streakDays', () => {
  const set = (...d: string[]) => new Set(d);
  it('counts consecutive days ending today', () => {
    expect(streakDays(set('2026-10-19', '2026-10-20', '2026-10-21'), '2026-10-21')).toBe(3);
  });
  it('keeps yesterday’s streak alive until today is over', () => {
    expect(streakDays(set('2026-10-19', '2026-10-20'), '2026-10-21')).toBe(2);
  });
  it('breaks on a gap', () => {
    expect(streakDays(set('2026-10-17', '2026-10-18', '2026-10-20', '2026-10-21'), '2026-10-21')).toBe(2);
  });
  it('is zero with nothing recent, and counts across month ends', () => {
    expect(streakDays(set('2026-10-10'), '2026-10-21')).toBe(0);
    expect(streakDays(set(), '2026-10-21')).toBe(0);
    expect(streakDays(set('2026-09-30', '2026-10-01', '2026-10-02'), '2026-10-02')).toBe(3);
  });
  it('stops at the look-back limit', () => {
    const all = new Set<string>();
    for (let i = 0; i < 10; i++) all.add(`2026-10-${String(21 - i).padStart(2, '0')}`);
    expect(streakDays(all, '2026-10-21', 5)).toBe(5);
  });
});

describe('fillDays', () => {
  it('always returns the whole range, with empty days zeroed', () => {
    const days = fillDays('2026-10-19', '2026-10-21', [day('2026-10-20', 1800)]);
    expect(days.map((d) => [d.localDate, d.calories, d.entries])).toEqual([
      ['2026-10-19', 0, 0],
      ['2026-10-20', 1800, 2],
      ['2026-10-21', 0, 0],
    ]);
  });
});

describe('summarizeWeek', () => {
  it('averages over logged days only and measures against the goal', () => {
    const s = summarizeWeek(
      [
        day('1', 2000),
        day('2', 0),
        day('3', 1800),
        day('4', 2600, { waterMl: 2000 }),
        day('5', 0),
        day('6', 0),
        day('7', 0),
      ],
      2000,
    );
    expect(s.daysLogged).toBe(3);
    expect(s.avgCalories).toBe(2133);
    expect(s.daysOnTarget).toBe(2); // 2000 and 1800 are within 10%; 2600 is not
    expect(s.avgVsGoalPct).toBe(6.7);
    expect(s.avgWaterMl).toBe(2000);
    expect(s.calorieGoal).toBe(2000);
  });
  it('has no averages when nothing was logged', () => {
    const s = summarizeWeek([day('1', 0)], 2000);
    expect(s).toMatchObject({
      daysLogged: 0,
      avgCalories: null,
      avgProteinG: null,
      avgVsGoalPct: null,
      avgWaterMl: null,
      daysOnTarget: 0,
    });
  });
});

describe('weightChange', () => {
  it('needs two logs and compares the first with the last', () => {
    expect(weightChange([])).toBeNull();
    expect(weightChange([{ localDate: '2026-10-15', loggedAt: 1, weightKg: 80 }])).toBeNull();
    expect(
      weightChange([
        { localDate: '2026-10-21', loggedAt: 3, weightKg: 79.2 },
        { localDate: '2026-10-15', loggedAt: 1, weightKg: 80 },
        { localDate: '2026-10-18', loggedAt: 2, weightKg: 79.6 },
      ]),
    ).toEqual({ startKg: 80, endKg: 79.2, changeKg: -0.8 });
  });
});

describe('highlights', () => {
  const base = (over: Partial<Parameters<typeof highlights>[0]> = {}) => ({
    summary: summarizeWeek(
      [
        day('1', 2000),
        day('2', 2000),
        day('3', 2100),
        day('4', 1900),
        day('5', 2000),
        day('6', 0),
        day('7', 0),
      ],
      2000,
    ),
    streak: 5,
    weight: null,
    trainingSessions: 0,
    ...over,
  }); // fmt: skip
  it('says plainly what happened', () => {
    expect(highlights(base())).toEqual([
      'You logged meals on 5 of 7 days.',
      'Your average was close to your daily goal.',
      'That is a 5 day logging streak.',
    ]);
  });
  it('reports being above or below the goal in kcal, without judgement', () => {
    const over = summarizeWeek([day('1', 2600)], 2000);
    expect(highlights(base({ summary: over, streak: 0 }))[1]).toBe(
      'You averaged 600 kcal above your daily goal.',
    );
    const under = summarizeWeek([day('1', 1500)], 2000);
    expect(highlights(base({ summary: under, streak: 0 }))[1]).toBe(
      'You averaged 500 kcal below your daily goal.',
    );
  });
  it('mentions water, training and weight when there is something to say', () => {
    const summary = summarizeWeek([day('1', 2000, { waterMl: 2100 })], 2000);
    const out = highlights({
      summary,
      streak: 1,
      weight: { startKg: 80, endKg: 80.4, changeKg: 0.4 },
      trainingSessions: 1,
    });
    expect(out).toContain('You averaged 2.1 L of water on the days you logged it.');
    expect(out).toContain('You finished 1 workout.');
    expect(out).toContain('Your logged weight changed by +0.4 kg.');
    expect(highlights({ summary, streak: 1, weight: null, trainingSessions: 3 })).toContain(
      'You finished 3 workouts.',
    );
  });
  it('handles an empty week', () => {
    expect(highlights(base({ summary: summarizeWeek([day('1', 0)], 2000), streak: 0 }))).toEqual([
      'No meals were logged this week.',
    ]);
  });
});
