import { first, run } from '../../db/sql';

export type EmailCodeRow = {
  id: string;
  email_hash: string;
  code_hash: string;
  attempts: number;
  created_at: number;
  expires_at: number;
  consumed_at: number | null;
};

export class EmailCodesRepo {
  constructor(private db: D1Database) {}

  /** Replace any code still waiting for this address with a new one: only the latest works. */
  async issue(c: { id: string; emailHash: string; codeHash: string; now: number; expiresAt: number }) {
    await this.db.batch([
      this.db
        .prepare('UPDATE email_codes SET consumed_at = ? WHERE email_hash = ? AND consumed_at IS NULL')
        .bind(c.now, c.emailHash),
      this.db
        .prepare(
          'INSERT INTO email_codes (id, email_hash, code_hash, created_at, expires_at) VALUES (?, ?, ?, ?, ?)',
        )
        .bind(c.id, c.emailHash, c.codeHash, c.now, c.expiresAt),
    ]);
  }

  async discard(id: string): Promise<void> {
    await run(this.db.prepare('DELETE FROM email_codes WHERE id = ?').bind(id));
  }

  latest(emailHash: string): Promise<EmailCodeRow | null> {
    return first<EmailCodeRow>(
      this.db
        .prepare('SELECT * FROM email_codes WHERE email_hash = ? ORDER BY created_at DESC, id DESC LIMIT 1')
        .bind(emailHash),
    );
  }

  async countSince(emailHash: string, since: number): Promise<number> {
    const row = await first<{ n: number }>(
      this.db
        .prepare('SELECT COUNT(*) AS n FROM email_codes WHERE email_hash = ? AND created_at >= ?')
        .bind(emailHash, since),
    );
    return row?.n ?? 0;
  }

  /** The newest code that can still be tried, and spends one of its attempts in the same statement. */
  async takeAttempt(emailHash: string, now: number, maxAttempts: number): Promise<EmailCodeRow | null> {
    return first<EmailCodeRow>(
      this.db
        .prepare(
          `UPDATE email_codes SET attempts = attempts + 1
           WHERE id = (SELECT id FROM email_codes
                       WHERE email_hash = ?1 AND consumed_at IS NULL AND expires_at > ?2 AND attempts < ?3
                       ORDER BY created_at DESC, id DESC LIMIT 1)
             AND consumed_at IS NULL AND attempts < ?3
           RETURNING *`,
        )
        .bind(emailHash, now, maxAttempts),
    );
  }

  /** True for exactly one caller, even if two requests present the right code together. */
  async consume(id: string, now: number): Promise<boolean> {
    const changed = await run(
      this.db
        .prepare('UPDATE email_codes SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL')
        .bind(now, id),
    );
    return changed === 1;
  }
}
