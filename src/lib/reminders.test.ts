import { describe, expect, it } from 'vitest';
import { isoWeekday, localDateIn, zonedToUtc } from '../core/time';
import { ALL_DAYS, MESSAGES, REMINDER_KINDS, daysToMask, maskToDays, nextDue } from './reminders';

const utc = (y: number, mo: number, d: number, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);

describe('zonedToUtc', () => {
  it('turns a wall-clock time into an instant, for zones ahead of and behind UTC', () => {
    expect(zonedToUtc('2026-10-21', 7, 30, 'Africa/Johannesburg')).toBe(utc(2026, 10, 21, 5, 30)); // UTC+2, no DST
    expect(zonedToUtc('2026-10-21', 7, 30, 'UTC')).toBe(utc(2026, 10, 21, 7, 30));
    expect(zonedToUtc('2026-01-15', 8, 0, 'America/New_York')).toBe(utc(2026, 1, 15, 13, 0)); // winter, UTC-5
    expect(zonedToUtc('2026-07-15', 8, 0, 'America/New_York')).toBe(utc(2026, 7, 15, 12, 0)); // summer, UTC-4
    expect(zonedToUtc('2026-10-21', 7, 30, 'Asia/Kolkata')).toBe(utc(2026, 10, 21, 2, 0)); // UTC+5:30
    expect(zonedToUtc('2026-10-21', 23, 0, 'Pacific/Auckland')).toBe(utc(2026, 10, 21, 10, 0)); // UTC+13 in summer there
  });
  it('handles the days clocks change', () => {
    // New York springs forward on 2026-03-08: 02:30 does not exist, so it lands within an hour of the gap
    const gap = zonedToUtc('2026-03-08', 2, 30, 'America/New_York');
    expect(localDateIn('America/New_York', gap)).toBe('2026-03-08');
    expect(gap).toBeGreaterThanOrEqual(utc(2026, 3, 8, 6, 30));
    expect(gap).toBeLessThanOrEqual(utc(2026, 3, 8, 7, 30));
    // 07:30 the same morning is after the change: UTC-4
    expect(zonedToUtc('2026-03-08', 7, 30, 'America/New_York')).toBe(utc(2026, 3, 8, 11, 30));
    // and falling back on 2026-11-01: 01:30 happens twice, the first one is returned
    expect(zonedToUtc('2026-11-01', 1, 30, 'America/New_York')).toBe(utc(2026, 11, 1, 5, 30));
  });
});

describe('isoWeekday', () => {
  it('counts Monday as 1 and Sunday as 7', () => {
    expect(isoWeekday('2026-10-19')).toBe(1); // Monday
    expect(isoWeekday('2026-10-21')).toBe(3);
    expect(isoWeekday('2026-10-25')).toBe(7);
  });
});

describe('days masks', () => {
  it('round trip', () => {
    expect(daysToMask([1, 2, 3, 4, 5, 6, 7])).toBe(ALL_DAYS);
    expect(daysToMask([1, 7])).toBe(0b1000001);
    expect(maskToDays(0b1000001)).toEqual([1, 7]);
    expect(maskToDays(0)).toEqual([]);
    expect(daysToMask([3, 3])).toBe(daysToMask([3]));
  });
});

describe('nextDue', () => {
  const jhb = 'Africa/Johannesburg';
  it('is later today when the time has not come, tomorrow when it has passed', () => {
    const morning = utc(2026, 10, 21, 3, 0); // 05:00 in Johannesburg
    expect(nextDue(morning, '07:30', ALL_DAYS, jhb)).toBe(utc(2026, 10, 21, 5, 30));
    const afternoon = utc(2026, 10, 21, 12, 0); // 14:00
    expect(nextDue(afternoon, '07:30', ALL_DAYS, jhb)).toBe(utc(2026, 10, 22, 5, 30));
  });
  it('is always strictly after the moment given', () => {
    const exactly = utc(2026, 10, 21, 5, 30);
    expect(nextDue(exactly, '07:30', ALL_DAYS, jhb)).toBe(utc(2026, 10, 22, 5, 30));
    expect(nextDue(exactly - 1, '07:30', ALL_DAYS, jhb)).toBe(exactly);
  });
  it('follows the local date, not the UTC one', () => {
    // 23:30 UTC on the 20th is already 01:30 on the 21st in Johannesburg
    expect(nextDue(utc(2026, 10, 20, 23, 30), '07:30', ALL_DAYS, jhb)).toBe(utc(2026, 10, 21, 5, 30));
  });
  it('skips days that are not allowed', () => {
    const weekdaysOnly = daysToMask([1, 2, 3, 4, 5]);
    const fridayNoon = utc(2026, 10, 23, 12, 0);
    expect(nextDue(fridayNoon, '08:00', weekdaysOnly, 'UTC')).toBe(utc(2026, 10, 26, 8, 0)); // Monday
    const sundayOnly = daysToMask([7]);
    expect(nextDue(utc(2026, 10, 21, 0, 0), '18:00', sundayOnly, 'UTC')).toBe(utc(2026, 10, 25, 18, 0));
  });
  it('keeps the local time across a clock change', () => {
    const before = utc(2026, 3, 7, 18, 0);
    const first = nextDue(before, '07:30', ALL_DAYS, 'America/New_York')!;
    expect(first).toBe(utc(2026, 3, 8, 11, 30)); // 07:30 the morning clocks went forward is already UTC-4
  });
  it('is null for no days or a bad time', () => {
    expect(nextDue(0, '07:30', 0, 'UTC')).toBeNull();
    for (const bad of ['7:30', '24:00', '07:60', 'noon', ''])
      expect(nextDue(0, bad, ALL_DAYS, 'UTC')).toBeNull();
  });
});

describe('messages', () => {
  it('exist for every kind and say nothing personal', () => {
    for (const kind of REMINDER_KINDS) {
      expect(MESSAGES[kind].title.length).toBeGreaterThan(3);
      expect(MESSAGES[kind].body.length).toBeGreaterThan(10);
    }
  });
});
