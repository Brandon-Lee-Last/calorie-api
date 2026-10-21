import { DAY, type Clock } from '../../core/time';
import { STALE_DEVICE_MS } from '../reminders/reminders.service';
import { AUDIT_RETENTION_MS } from '../admin/audit.service';
import type { Logger } from '../../core/logger';

export const TOMBSTONE_RETENTION_MS = 30 * DAY;
const BATCH = 500;
const MAX_BATCHES_PER_TABLE = 40;

const SYNCED_TABLES = [
  'diary_entries',
  'weight_logs',
  'water_logs',
  'foods',
  'workout_sessions',
  'recipes',
  'activity_logs',
  'body_measurements',
  'progress_photos',
] as const;

export type MaintenanceReport = {
  refreshTokensRemoved: number;
  tombstonesRemoved: Record<string, number>;
  usageCountersRemoved: number;
  rateLimitsRemoved: number;
  emailCodesRemoved: number;
  adminAuditRemoved: number;
  devicesRemoved: number;
  subscriptionsReconciled: number;
};

/**
 * Housekeeping that runs every night (and on demand from the admin API). It is safe to run twice, and it works in
 * small batches so a big backlog cannot make one run time out; whatever is left is picked up the next night.
 */
export class MaintenanceService {
  constructor(
    private db: D1Database,
    private clock: Clock,
    private logger: Logger,
    /** Re-reads store state for subscriptions that may have changed unnoticed. */
    private reconcileSubscriptions: () => Promise<number> = async () => 0,
  ) {}

  async run(): Promise<MaintenanceReport> {
    const now = this.clock.now();
    const report: MaintenanceReport = {
      refreshTokensRemoved: 0,
      tombstonesRemoved: {},
      usageCountersRemoved: 0,
      rateLimitsRemoved: 0,
      emailCodesRemoved: 0,
      adminAuditRemoved: 0,
      devicesRemoved: 0,
      subscriptionsReconciled: 0,
    };

    // Refresh tokens that expired a week ago, or were revoked a month ago, can no longer matter.
    report.refreshTokensRemoved = (
      await this.db
        .prepare(
          'DELETE FROM refresh_tokens WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)',
        )
        .bind(now - 7 * DAY, now - 30 * DAY)
        .run()
    ).meta.changes;

    for (const table of SYNCED_TABLES)
      report.tombstonesRemoved[table] = await this.purgeTombstones(table, now - TOMBSTONE_RETENTION_MS);

    const oldestPeriod = new Date(now - 3 * DAY).toISOString().slice(0, 10);
    report.usageCountersRemoved = (
      await this.db.prepare('DELETE FROM usage_counters WHERE period < ?').bind(oldestPeriod).run()
    ).meta.changes;

    // Rate-limit windows are at most a day long, so anything older than two days is finished.
    report.rateLimitsRemoved = (
      await this.db
        .prepare('DELETE FROM rate_limits WHERE window_start < ?')
        .bind(now - 2 * DAY)
        .run()
    ).meta.changes;

    report.emailCodesRemoved = (
      await this.db
        .prepare('DELETE FROM email_codes WHERE expires_at < ?')
        .bind(now - DAY)
        .run()
    ).meta.changes;

    report.adminAuditRemoved = (
      await this.db
        .prepare('DELETE FROM admin_audit WHERE at < ?')
        .bind(now - AUDIT_RETENTION_MS)
        .run()
    ).meta.changes;

    // A phone that has not checked in for six months has almost certainly lost the app.
    report.devicesRemoved = (
      await this.db
        .prepare('DELETE FROM devices WHERE last_seen_at < ?')
        .bind(now - STALE_DEVICE_MS)
        .run()
    ).meta.changes;

    report.subscriptionsReconciled = await this.reconcileSubscriptions();

    this.logger.info('maintenance finished', { ...report });
    return report;
  }

  /**
   * Remove deletion markers older than `before`. First note, per user, the newest revision being removed, so a device that
   * has not synced since then is told to start over rather than silently keeping records that were deleted.
   */
  private async purgeTombstones(table: string, before: number): Promise<number> {
    // The same ordered slice is used to note the revisions and to delete the rows, so they always agree.
    const slice = `SELECT rowid AS rid, user_id, rev FROM ${table} WHERE deleted_at IS NOT NULL AND deleted_at < ? ORDER BY deleted_at, rowid LIMIT ${BATCH}`;
    let removed = 0;
    for (let i = 0; i < MAX_BATCHES_PER_TABLE; i++) {
      const [, del] = await this.db.batch([
        this.db
          .prepare(
            `UPDATE users SET purged_rev = MAX(purged_rev, (SELECT MAX(rev) FROM (${slice}) s WHERE s.user_id = users.id))
             WHERE id IN (SELECT user_id FROM (${slice}) WHERE user_id IS NOT NULL)`,
          )
          .bind(before, before),
        this.db.prepare(`DELETE FROM ${table} WHERE rowid IN (SELECT rid FROM (${slice}))`).bind(before),
      ]);
      const n = del!.meta.changes ?? 0;
      removed += n;
      if (n < BATCH) break;
    }
    return removed;
  }
}
