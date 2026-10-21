import { first, all } from './sql';

export type UpsertResult = { applied: boolean };
export type DeleteResult = { outcome: 'applied' | 'stale' | 'noop' };

/**
 * SQL for a table whose rows sync between devices. Every write also bumps the user's revision counter and stamps the
 * row with it (in the same D1 batch, so they commit together), which is what lets `sync/pull` say "everything after N".
 *
 * Conflict rule: the edit with the later `client_updated_at` wins; a tie goes to the newer arrival, so a retried
 * request is harmless. A row id that belongs to another user is never touched.
 */
export class SyncedTable {
  /** `columns` are the table's own data columns (snake_case), not the shared id/user/time/rev columns. */
  constructor(
    readonly table: string,
    readonly columns: readonly string[],
  ) {}

  async upsert(
    db: D1Database,
    userId: string,
    id: string,
    data: Record<string, unknown>,
    clientUpdatedAt: number,
    now: number,
  ): Promise<UpsertResult> {
    for (const c of this.columns)
      if (!(c in data)) throw new Error(`${this.table}.upsert is missing column ${c}`);
    const cols = this.columns.join(', ');
    const marks = this.columns.map(() => '?').join(', ');
    const assign = this.columns.map((c) => `${c} = excluded.${c}`).join(', ');
    const t = this.table;
    const results = await db.batch([
      db.prepare('UPDATE users SET sync_rev = sync_rev + 1 WHERE id = ?').bind(userId),
      db
        .prepare(
          `INSERT INTO ${t} (id, user_id, ${cols}, created_at, updated_at, deleted_at, client_updated_at, rev)
           VALUES (?, ?, ${marks}, ?, ?, NULL, ?, (SELECT sync_rev FROM users WHERE id = ?))
           ON CONFLICT (id) DO UPDATE SET ${assign}, updated_at = excluded.updated_at, deleted_at = NULL,
             client_updated_at = excluded.client_updated_at, rev = excluded.rev
           WHERE ${t}.user_id = excluded.user_id AND excluded.client_updated_at >= ${t}.client_updated_at`,
        )
        .bind(id, userId, ...this.columns.map((c) => data[c] ?? null), now, now, clientUpdatedAt, userId),
    ]);
    return { applied: (results[1]!.meta.changes ?? 0) === 1 };
  }

  /**
   * Mark a row deleted. A delete that arrives through sync is an edit like any other and loses to a newer edit. A direct
   * DELETE request (`force`) is the person acting right now, so it always applies; the row's edit time moves forward so
   * it cannot be undone by an older offline edit.
   */
  async softDelete(
    db: D1Database,
    userId: string,
    id: string,
    clientUpdatedAt: number,
    now: number,
    force = false,
  ): Promise<DeleteResult> {
    const t = this.table;
    const results = await db.batch([
      db.prepare('UPDATE users SET sync_rev = sync_rev + 1 WHERE id = ?').bind(userId),
      db
        .prepare(
          `UPDATE ${t} SET deleted_at = ?, updated_at = ?, client_updated_at = MAX(client_updated_at, ?),
             rev = (SELECT sync_rev FROM users WHERE id = ?)
           WHERE id = ? AND user_id = ? AND deleted_at IS NULL AND (? = 1 OR ? >= client_updated_at)`,
        )
        .bind(now, now, clientUpdatedAt, userId, id, userId, force ? 1 : 0, clientUpdatedAt),
    ]);
    if ((results[1]!.meta.changes ?? 0) === 1) return { outcome: 'applied' };
    const row = await this.get(db, userId, id);
    return { outcome: row && row.deleted_at === null ? 'stale' : 'noop' };
  }

  get<Row extends { deleted_at: number | null }>(
    db: D1Database,
    userId: string,
    id: string,
  ): Promise<Row | null> {
    return first<Row>(
      db.prepare(`SELECT * FROM ${this.table} WHERE id = ? AND user_id = ?`).bind(id, userId),
    );
  }

  /** Does this id exist for somebody else? Used to answer a collision with 409 instead of silently doing nothing. */
  async takenByAnother(db: D1Database, userId: string, id: string): Promise<boolean> {
    const row = await first<{ user_id: string | null }>(
      db.prepare(`SELECT user_id FROM ${this.table} WHERE id = ?`).bind(id),
    );
    return row !== null && row.user_id !== userId;
  }

  /** Rows changed after revision `rev`, oldest first, optionally only up to and including `upTo`. */
  changesSince<Row>(
    db: D1Database,
    userId: string,
    rev: number,
    limit: number,
    upTo = Number.MAX_SAFE_INTEGER,
  ): Promise<Row[]> {
    return all<Row>(
      db
        .prepare(
          `SELECT * FROM ${this.table} WHERE user_id = ? AND rev > ? AND rev <= ? ORDER BY rev LIMIT ?`,
        )
        .bind(userId, rev, upTo, limit),
    );
  }
}
