import { badRequest, validationFailed } from '../../core/errors';
import { newId } from '../../core/ids';
import type { Logger } from '../../core/logger';
import { MINUTE, localDateIn, type Clock } from '../../core/time';
import { MESSAGES, TIME_RE, daysToMask, maskToDays, nextDue, type ReminderKind } from '../../lib/reminders';
import type { PushSender } from './push';
import type { DueRow, RemindersRepo, ReminderRow } from './reminders.repo';

/** A reminder that is more than this late is skipped, not sent: "breakfast time" at 11am is noise. */
export const LATE_AFTER_MS = 90 * MINUTE;
/** What one run handles. Each reminder costs a few database calls and one push per phone, and a Worker run has a call budget. */
export const MAX_PER_RUN = 60;
export const STALE_DEVICE_MS = 180 * 86_400_000;

export const toReminder = (r: ReminderRow) => ({
  kind: r.kind,
  enabled: r.enabled === 1,
  time: r.local_time,
  days: maskToDays(r.days_mask),
  nextDueAt: r.enabled === 1 ? r.next_due_at : null,
  lastSentAt: r.last_sent_at,
}); // fmt: skip

export type RunReport = {
  configured: boolean;
  due: number;
  sent: number;
  skipped: number;
  late: number;
  retried: number;
  invalidTokens: number;
};

export class RemindersService {
  constructor(
    private repo: RemindersRepo,
    private sender: PushSender,
    private clock: Clock,
    private logger: Logger,
  ) {}

  // ---- phones --------------------------------------------------------------------------------------------------

  async registerDevice(
    userId: string,
    d: { token: string; appVersion?: string | null; locale?: string | null },
  ) {
    await this.repo.upsertDevice({
      id: newId(this.clock.now()),
      userId,
      token: d.token,
      appVersion: d.appVersion ?? null,
      locale: d.locale ?? null,
      now: this.clock.now(),
    });
  }

  async unregisterDevice(userId: string, token: string) {
    await this.repo.removeDevice(userId, token);
  }

  // ---- settings ------------------------------------------------------------------------------------------------

  async list(userId: string) {
    return { items: (await this.repo.list(userId)).map(toReminder) };
  }

  async put(userId: string, kind: ReminderKind, input: { enabled: boolean; time: string; days: number[] }) {
    if (!TIME_RE.test(input.time))
      throw validationFailed([{ path: 'time', message: 'Use 24 hour time like 07:30' }]);
    const mask = daysToMask(input.days);
    if (mask === 0) throw validationFailed([{ path: 'days', message: 'Pick at least one day' }]);
    const now = this.clock.now();
    const tz = (await this.repo.timezone(userId))?.timezone ?? 'UTC';
    await this.repo.upsert({
      id: newId(now),
      userId,
      kind,
      time: input.time,
      mask,
      enabled: input.enabled,
      nextDueAt: input.enabled ? nextDue(now, input.time, mask, tz) : null,
      now,
    });
    return toReminder((await this.repo.get(userId, kind))!);
  }

  async remove(userId: string, kind: ReminderKind) {
    await this.repo.remove(userId, kind);
  }

  /** The person's timezone changed (they travelled, or fixed it): work out every reminder's next time again. */
  async reschedule(userId: string) {
    const now = this.clock.now();
    const tz = (await this.repo.timezone(userId))?.timezone ?? 'UTC';
    for (const r of await this.repo.list(userId))
      if (r.enabled === 1) await this.repo.setNextDue(r.id, nextDue(now, r.local_time, r.days_mask, tz));
  }

  /** Sends a notification to the person's phones now, so they can check that reminders reach them. */
  async sendTest(userId: string) {
    if (!this.sender.configured)
      throw badRequest('Notifications are not set up on this server yet', { reason: 'push_not_configured' });
    const devices = await this.repo.devicesFor(userId);
    if (devices.length === 0)
      throw badRequest('No phone is registered for notifications', { reason: 'no_device' });
    let delivered = 0;
    for (const d of devices) {
      const outcome = await this.sender.send({
        token: d.token,
        title: 'Reminders are working',
        body: 'You will get your reminders here.',
        data: { kind: 'test' },
      });
      if (outcome === 'sent') delivered++;
      if (outcome === 'invalid_token') await this.repo.removeToken(d.token);
    }
    return { devices: devices.length, delivered };
  }

  // ---- sending reminders ---------------------------------------------------------------------------------------

  /**
   * Called every few minutes. Each due reminder is claimed first (moved to its next time in one conditional update), so two
   * overlapping runs can never both send it. If every push then fails for a passing reason, the claim is handed back and the
   * next run tries again, until the reminder is too late to be useful.
   */
  async run(): Promise<RunReport> {
    const report: RunReport = {
      configured: this.sender.configured,
      due: 0,
      sent: 0,
      skipped: 0,
      late: 0,
      retried: 0,
      invalidTokens: 0,
    };
    if (!this.sender.configured) return report;
    const now = this.clock.now();
    const rows = await this.repo.due(now, MAX_PER_RUN);
    report.due = rows.length;
    for (const row of rows) {
      try {
        await this.handle(row, now, report);
      } catch (e) {
        // One person's problem must not stop everyone else's reminders.
        this.logger.error('reminder failed', { kind: row.kind, message: String(e) });
      }
    }
    if (report.due > 0) this.logger.info('reminders run', { ...report });
    return report;
  }

  private async handle(row: DueRow, now: number, report: RunReport) {
    const due = row.next_due_at!;
    const next = nextDue(now, row.local_time, row.days_mask, row.timezone);
    const tooLate = now - due > LATE_AFTER_MS;
    if (!(await this.repo.claim(row.id, due, next, tooLate ? null : now))) return; // another run has it
    if (tooLate) return void report.late++;

    if (
      row.kind === 'log_nudge' &&
      (await this.repo.hasDiaryEntry(row.user_id, localDateIn(row.timezone, now)))
    )
      return void report.skipped++; // they have already logged today: no nudge needed
    const devices = await this.repo.devicesFor(row.user_id);
    if (devices.length === 0) return void report.skipped++;

    const message = MESSAGES[row.kind];
    const outcomes = await Promise.all(
      devices.map((d) =>
        this.sender.send({
          token: d.token,
          title: message.title,
          body: message.body,
          data: { kind: row.kind },
        }),
      ),
    );
    let sent = 0;
    for (const [i, outcome] of outcomes.entries()) {
      if (outcome === 'sent') sent++;
      else if (outcome === 'invalid_token') {
        await this.repo.removeToken(devices[i]!.token);
        report.invalidTokens++;
      }
    }
    if (sent > 0) report.sent++;
    else if (outcomes.includes('retry')) {
      await this.repo.unclaim(row.id, next, due); // nothing went out and it may work in a few minutes
      report.retried++;
    } else report.skipped++;
  }
}
