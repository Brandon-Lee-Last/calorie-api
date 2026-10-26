import { all, run } from '../../db/sql';

export type CoachKind = 'chat' | 'crisis' | 'scope' | 'blocked';
export type CoachRow = {
  id: string;
  user_id: string;
  role: 'user' | 'assistant';
  content: string;
  kind: CoachKind;
  flags: string;
  created_at: number;
};

export class CoachRepo {
  constructor(private db: D1Database) {}

  async add(rows: CoachRow[]): Promise<void> {
    await this.db.batch(
      rows.map((r) =>
        this.db
          .prepare(
            'INSERT INTO coach_messages (id, user_id, role, content, kind, flags, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          )
          .bind(r.id, r.user_id, r.role, r.content, r.kind, r.flags, r.created_at),
      ),
    );
  }

  /** The latest messages, oldest first. */
  async latest(userId: string, limit: number): Promise<CoachRow[]> {
    const rows = await all<CoachRow>(
      this.db
        .prepare('SELECT * FROM coach_messages WHERE user_id = ? ORDER BY rowid DESC LIMIT ?')
        .bind(userId, limit),
    );
    return rows.reverse();
  }

  clear(userId: string): Promise<number> {
    return run(this.db.prepare('DELETE FROM coach_messages WHERE user_id = ?').bind(userId));
  }

  purgeBefore(before: number): Promise<number> {
    return run(this.db.prepare('DELETE FROM coach_messages WHERE created_at < ?').bind(before));
  }
}
