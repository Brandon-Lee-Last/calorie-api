import { addDays, isoWeekday, localDateIn, zonedToUtc } from '../core/time';

export const REMINDER_KINDS = ['breakfast', 'lunch', 'dinner', 'water', 'weigh_in', 'log_nudge'] as const;
export type ReminderKind = (typeof REMINDER_KINDS)[number];

export const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
export const ALL_DAYS = 127;

/** Weekdays 1 (Monday) to 7 (Sunday) as a bit mask: Monday is bit 0. */
export const daysToMask = (days: number[]) => days.reduce((m, d) => m | (1 << (d - 1)), 0);
export const maskToDays = (mask: number) => [1, 2, 3, 4, 5, 6, 7].filter((d) => mask & (1 << (d - 1)));

/**
 * The first moment after `after` at which the local clock in `timeZone` reads `time` on one of the allowed weekdays.
 * Null when no day is allowed.
 */
export function nextDue(after: number, time: string, mask: number, timeZone: string): number | null {
  const m = TIME_RE.exec(time);
  if (!m || (mask & ALL_DAYS) === 0) return null;
  const start = localDateIn(timeZone, after);
  for (let i = 0; i <= 8; i++) {
    const date = addDays(start, i);
    if (!(mask & (1 << (isoWeekday(date) - 1)))) continue;
    const at = zonedToUtc(date, Number(m[1]), Number(m[2]), timeZone);
    if (at > after) return at;
  }
  return null;
}

/** The words of each reminder. They say nothing about the person: a lock screen is public. */
export const MESSAGES: Record<ReminderKind, { title: string; body: string }> = {
  breakfast: { title: 'Breakfast time', body: 'Log what you ate to keep your day on track.' },
  lunch: { title: 'Lunch time', body: 'Log your meal while you remember it.' },
  dinner: { title: 'Dinner time', body: 'Log your meal to finish the day on track.' },
  water: { title: 'Time for some water', body: 'A glass now keeps you on track.' },
  weigh_in: { title: 'Weigh-in day', body: 'Log your weight to see your trend.' },
  log_nudge: { title: 'Haven’t logged today?', body: 'A quick log keeps your day accurate.' },
};
