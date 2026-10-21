import { all, firstOnce, run } from '../../db/sql';

export class UsageRepo {
  constructor(private db: D1Database) {}

  /**
   * Add one to a counter, but only if it is still below `limit`. One statement, so two requests arriving together cannot
   * both slip past the limit. Returns the new count, or null if the limit was already reached.
   */
  async incrementWithin(userId: string, key: string, period: string, limit: number): Promise<number | null> {
    const row = await firstOnce<{ count: number }>(
      this.db
        .prepare(
          `INSERT INTO usage_counters (user_id, key, period, count) VALUES (?, ?, ?, 1)
           ON CONFLICT (user_id, key, period) DO UPDATE SET count = count + 1 WHERE count < ?
           RETURNING count`,
        )
        .bind(userId, key, period, limit),
    );
    return row?.count ?? null;
  }

  /** Count something without limiting it. */
  async add(userId: string, key: string, period: string): Promise<void> {
    await run(
      this.db
        .prepare(
          `INSERT INTO usage_counters (user_id, key, period, count) VALUES (?, ?, ?, 1)
           ON CONFLICT (user_id, key, period) DO UPDATE SET count = count + 1`,
        )
        .bind(userId, key, period),
    );
  }

  /** Give one back (used when the thing that was counted failed). Never goes below zero. */
  async remove(userId: string, key: string, period: string): Promise<void> {
    await run(
      this.db
        .prepare(
          'UPDATE usage_counters SET count = MAX(count - 1, 0) WHERE user_id = ? AND key = ? AND period = ?',
        )
        .bind(userId, key, period),
    );
  }

  async forPeriod(userId: string, period: string): Promise<Record<string, number>> {
    const rows = await all<{ key: string; count: number }>(
      this.db
        .prepare('SELECT key, count FROM usage_counters WHERE user_id = ? AND period = ?')
        .bind(userId, period),
    );
    return Object.fromEntries(rows.map((r) => [r.key, r.count]));
  }
}
