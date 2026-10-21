/** Anything that needs "now" takes a Clock, so tests can freeze and move time. */
export interface Clock {
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

export class FakeClock implements Clock {
  constructor(private t: number) {}
  now(): number {
    return this.t;
  }
  set(t: number): void {
    this.t = t;
  }
  advance(ms: number): void {
    this.t += ms;
  }
}

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

const LOCAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** True for a real calendar date written YYYY-MM-DD (rejects 2026-02-30). */
export function isLocalDate(s: unknown): s is string {
  if (typeof s !== 'string') return false;
  const m = LOCAL_DATE_RE.exec(s);
  if (!m) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function addDays(localDate: string, days: number): string {
  const [y, m, d] = localDate.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** The calendar date of an instant in the given IANA timezone, as YYYY-MM-DD. */
export function localDateIn(timeZone: string, ms: number): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

export function isTimeZone(tz: unknown): tz is string {
  if (typeof tz !== 'string' || tz.length === 0 || tz.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Inclusive list of dates from `from` to `to`. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to && out.length < 4000; d = addDays(d, 1)) out.push(d);
  return out;
}

/** Phones' clocks are wrong sometimes. How far into the future a device timestamp may be before it is not believed. */
export const MAX_CLIENT_SKEW_MS = 24 * HOUR;
export const EARLIEST_LOGGED_AT = Date.UTC(2015, 0, 1);

/**
 * A device's "last edited" time decides which of two edits wins, so a device whose clock is far ahead must not be able
 * to win every time. Anything more than five minutes in the future is treated as five minutes in the future.
 */
export function clampClientTime(clientMs: number, nowMs: number): number {
  return Math.min(clientMs, nowMs + 5 * MINUTE);
}

/** True when `loggedAt` is a believable moment for something a person logs (not before 2015, not far ahead). */
export function isPlausibleLoggedAt(loggedAt: number, nowMs: number): boolean {
  return loggedAt >= EARLIEST_LOGGED_AT && loggedAt <= nowMs + MAX_CLIENT_SKEW_MS;
}

/** The local date can differ from the UTC date by a day at most (timezones run from UTC-12 to UTC+14). */
export function localDateMatchesInstant(localDate: string, instantMs: number): boolean {
  const utc = new Date(instantMs).toISOString().slice(0, 10);
  return localDate === utc || localDate === addDays(utc, 1) || localDate === addDays(utc, -1);
}
