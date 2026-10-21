import { all, first, run } from '../../db/sql';
import type { ReminderKind } from '../../lib/reminders';

export type ReminderRow = {
  id: string;
  user_id: string;
  kind: ReminderKind;
  local_time: string;
  days_mask: number;
  enabled: number;
  next_due_at: number | null;
  last_sent_at: number | null;
  created_at: number;
  updated_at: number;
}; // fmt: skip
export type DueRow = ReminderRow & { timezone: string };
export type DeviceRow = {
  id: string;
  user_id: string;
  token: string;
  platform: string;
  app_version: string | null;
  locale: string | null;
  created_at: number;
  last_seen_at: number;
}; // fmt: skip

export const MAX_DEVICES_PER_USER = 10;

export class RemindersRepo {
  constructor(private db: D1Database) {}

  // ---- devices -------------------------------------------------------------------------------------------------

  /** A token belongs to one person: if it was registered by someone else (a phone that changed hands), it moves. */
  async upsertDevice(d: {
    id: string;
    userId: string;
    token: string;
    appVersion: string | null;
    locale: string | null;
    now: number;
  }) {
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO devices (id, user_id, token, platform, app_version, locale, created_at, last_seen_at)
           VALUES (?, ?, ?, 'android', ?, ?, ?, ?)
           ON CONFLICT (token) DO UPDATE SET user_id = excluded.user_id, app_version = excluded.app_version,
             locale = excluded.locale, last_seen_at = excluded.last_seen_at`,
        )
        .bind(d.id, d.userId, d.token, d.appVersion, d.locale, d.now, d.now),
      // Keep only the newest few phones per person.
      this.db
        .prepare(
          `DELETE FROM devices WHERE user_id = ?1 AND id NOT IN
             (SELECT id FROM devices WHERE user_id = ?1 ORDER BY last_seen_at DESC, id DESC LIMIT ?2)`,
        )
        .bind(d.userId, MAX_DEVICES_PER_USER),
    ]);
  }
  async removeDevice(userId: string, token: string): Promise<boolean> {
    return (
      (await run(
        this.db.prepare('DELETE FROM devices WHERE user_id = ? AND token = ?').bind(userId, token),
      )) === 1
    );
  }
  async removeToken(token: string): Promise<void> {
    await run(this.db.prepare('DELETE FROM devices WHERE token = ?').bind(token));
  }
  devicesFor(userId: string): Promise<DeviceRow[]> {
    return all<DeviceRow>(
      this.db.prepare('SELECT * FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC').bind(userId),
    );
  }

  // ---- reminders -----------------------------------------------------------------------------------------------

  list(userId: string): Promise<ReminderRow[]> {
    return all<ReminderRow>(
      this.db.prepare('SELECT * FROM reminders WHERE user_id = ? ORDER BY kind').bind(userId),
    );
  }
  get(userId: string, kind: string) {
    return first<ReminderRow>(
      this.db.prepare('SELECT * FROM reminders WHERE user_id = ? AND kind = ?').bind(userId, kind),
    );
  }
  async upsert(r: {
    id: string;
    userId: string;
    kind: ReminderKind;
    time: string;
    mask: number;
    enabled: boolean;
    nextDueAt: number | null;
    now: number;
  }) {
    await run(
      this.db
        .prepare(
          `INSERT INTO reminders (id, user_id, kind, local_time, days_mask, enabled, next_due_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (user_id, kind) DO UPDATE SET local_time = excluded.local_time, days_mask = excluded.days_mask,
             enabled = excluded.enabled, next_due_at = excluded.next_due_at, updated_at = excluded.updated_at`,
        )
        .bind(r.id, r.userId, r.kind, r.time, r.mask, r.enabled ? 1 : 0, r.nextDueAt, r.now, r.now),
    );
  }
  async remove(userId: string, kind: string): Promise<boolean> {
    return (
      (await run(
        this.db.prepare('DELETE FROM reminders WHERE user_id = ? AND kind = ?').bind(userId, kind),
      )) === 1
    );
  }
  async setNextDue(id: string, nextDueAt: number | null): Promise<void> {
    await run(this.db.prepare('UPDATE reminders SET next_due_at = ? WHERE id = ?').bind(nextDueAt, id));
  }
  timezone(userId: string): Promise<{ timezone: string } | null> {
    return first<{ timezone: string }>(
      this.db.prepare('SELECT timezone FROM user_profiles WHERE user_id = ?').bind(userId),
    );
  }

  // ---- sending -------------------------------------------------------------------------------------------------

  /** Reminders whose time has come, oldest first, with the owner's timezone. */
  due(now: number, limit: number): Promise<DueRow[]> {
    return all<DueRow>(
      this.db
        .prepare(
          `SELECT r.*, p.timezone FROM reminders r JOIN user_profiles p ON p.user_id = r.user_id
           WHERE r.enabled = 1 AND r.next_due_at IS NOT NULL AND r.next_due_at <= ? ORDER BY r.next_due_at, r.id LIMIT ?`,
        )
        .bind(now, limit),
    );
  }
  /** Moves a reminder to its next time, but only if nobody else did first. True for exactly one caller. */
  async claim(id: string, from: number, to: number | null, sentAt: number | null): Promise<boolean> {
    return (
      (await run(
        this.db
          .prepare(
            'UPDATE reminders SET next_due_at = ?, last_sent_at = COALESCE(?, last_sent_at) WHERE id = ? AND next_due_at = ?',
          )
          .bind(to, sentAt, id, from),
      )) === 1
    );
  }
  /** Gives a claimed reminder back, so the next run tries it again. */
  async unclaim(id: string, claimedTo: number | null, back: number): Promise<void> {
    await run(
      this.db
        .prepare('UPDATE reminders SET next_due_at = ? WHERE id = ? AND next_due_at IS ?')
        .bind(back, id, claimedTo),
    );
  }
  async hasDiaryEntry(userId: string, localDate: string): Promise<boolean> {
    return (
      (await first(
        this.db
          .prepare(
            'SELECT 1 AS x FROM diary_entries WHERE user_id = ? AND local_date = ? AND deleted_at IS NULL LIMIT 1',
          )
          .bind(userId, localDate),
      )) !== null
    );
  }
  async purgeStaleDevices(before: number): Promise<number> {
    return run(this.db.prepare('DELETE FROM devices WHERE last_seen_at < ?').bind(before));
  }
}
