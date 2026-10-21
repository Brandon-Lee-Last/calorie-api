import { all, run } from '../../db/sql';

export type AuditRow = {
  id: string;
  at: number;
  actor: string;
  method: string;
  path: string;
  status: number;
  ip_hash: string;
  request_id: string;
};

export class AuditRepo {
  constructor(private db: D1Database) {}

  async insert(r: AuditRow): Promise<void> {
    await run(
      this.db
        .prepare(
          'INSERT INTO admin_audit (id, at, actor, method, path, status, ip_hash, request_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(r.id, r.at, r.actor, r.method, r.path, r.status, r.ip_hash, r.request_id),
    );
  }

  /** Newest first. `before` is the id of the last row of the previous page (ids sort by time). */
  list(limit: number, before: string | null): Promise<AuditRow[]> {
    return all<AuditRow>(
      before
        ? this.db
            .prepare('SELECT * FROM admin_audit WHERE id < ? ORDER BY id DESC LIMIT ?')
            .bind(before, limit)
        : this.db.prepare('SELECT * FROM admin_audit ORDER BY id DESC LIMIT ?').bind(limit),
    );
  }
}
