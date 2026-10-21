import { all, first, run } from '../../db/sql';

/** Everything the person put into the app, as plain rows, for the data export. */
export class AccountRepo {
  constructor(private db: D1Database) {}

  private rows<T>(table: string, userId: string, where = '', order = 'rowid'): Promise<T[]> {
    return all<T>(
      this.db.prepare(`SELECT * FROM ${table} WHERE user_id = ? ${where} ORDER BY ${order}`).bind(userId),
    );
  }

  user(userId: string) {
    return first<Record<string, unknown>>(
      this.db.prepare('SELECT id, created_at, email, display_name FROM users WHERE id = ?').bind(userId),
    );
  }
  profile(userId: string) {
    return first<Record<string, unknown>>(
      this.db.prepare('SELECT * FROM user_profiles WHERE user_id = ?').bind(userId),
    );
  }
  identities(userId: string) {
    return all<Record<string, unknown>>(
      this.db.prepare('SELECT provider, email, created_at FROM identities WHERE user_id = ?').bind(userId),
    );
  }
  diary(userId: string) {
    return this.rows<Record<string, unknown>>(
      'diary_entries',
      userId,
      'AND deleted_at IS NULL',
      'local_date, logged_at',
    );
  }
  weight(userId: string) {
    return this.rows<Record<string, unknown>>(
      'weight_logs',
      userId,
      'AND deleted_at IS NULL',
      'local_date, logged_at',
    );
  }
  water(userId: string) {
    return this.rows<Record<string, unknown>>(
      'water_logs',
      userId,
      'AND deleted_at IS NULL',
      'local_date, logged_at',
    );
  }
  foods(userId: string) {
    return this.rows<Record<string, unknown>>('foods', userId, 'AND deleted_at IS NULL', 'name_norm');
  }
  scans(userId: string) {
    return this.rows<Record<string, unknown>>('scan_events', userId, '', 'created_at');
  }
  sessions(userId: string) {
    return this.rows<Record<string, unknown>>(
      'workout_sessions',
      userId,
      'AND deleted_at IS NULL',
      'started_at',
    );
  }
  subscriptions(userId: string) {
    return all<Record<string, unknown>>(
      this.db
        .prepare(
          'SELECT provider, product_id, status, auto_renew, started_at, current_period_end, canceled_at, environment FROM subscriptions WHERE user_id = ? ORDER BY started_at',
        )
        .bind(userId),
    );
  }
  enrollments(userId: string) {
    return all<Record<string, unknown>>(
      this.db
        .prepare(
          'SELECT p.slug AS program, e.status, e.started_at FROM program_enrollments e JOIN programs p ON p.id = e.program_id WHERE e.user_id = ? ORDER BY e.started_at',
        )
        .bind(userId),
    );
  }

  /** Removing the user row removes everything that belongs to them (the tables cascade). */
  async deleteUser(userId: string): Promise<boolean> {
    // `changes` can include the cascaded child rows, so "at least one" is the right test.
    return (await run(this.db.prepare('DELETE FROM users WHERE id = ?').bind(userId))) > 0;
  }
}
