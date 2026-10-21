import { validationFailed } from './errors';
import { addDays, clampClientTime, isPlausibleLoggedAt, localDateMatchesInstant } from './time';

/**
 * Checks that a logged item's time and calendar date make sense together and against the server clock.
 * Throws one validation error listing every problem.
 */
export function assertLoggedTime(input: { loggedAt: number; localDate: string }, nowMs: number): void {
  const problems: { path: string; message: string }[] = [];
  if (!isPlausibleLoggedAt(input.loggedAt, nowMs)) {
    problems.push({ path: 'loggedAt', message: 'Must be after 2015 and not more than a day in the future' });
  } else if (!localDateMatchesInstant(input.localDate, input.loggedAt)) {
    problems.push({
      path: 'localDate',
      message: 'Does not match loggedAt (they can differ by one day at most, for timezones)',
    });
  }
  if (problems.length) throw validationFailed(problems);
}

export const sanitizeClientTime = clampClientTime;

/** The range a list endpoint may ask for, so one request cannot read a user's whole history. */
export function assertRangeWithin(from: string, to: string, maxDays: number): void {
  if (addDays(from, maxDays - 1) < to) {
    throw validationFailed([{ path: 'to', message: `The range may span at most ${maxDays} days` }]);
  }
}
