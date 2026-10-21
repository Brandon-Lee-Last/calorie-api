import { all, batch, first, run } from '../../db/sql';

export type UserRow = {
  id: string;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
  email: string | null;
  display_name: string | null;
};

export type IdentityRow = {
  id: string;
  user_id: string;
  provider: 'google';
  subject: string;
  email: string | null;
  created_at: number;
};

export type RefreshRow = {
  id: string;
  user_id: string;
  family_id: string;
  token_hash: string;
  device_label: string | null;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  revoked_at: number | null;
};

export class AuthRepo {
  constructor(private db: D1Database) {}

  /** A user and their (default) profile row are created together or not at all. */
  async createUser(u: {
    id: string;
    now: number;
    email?: string | null;
    displayName?: string | null;
  }): Promise<void> {
    await batch(this.db, [
      this.db
        .prepare('INSERT INTO users (id, created_at, updated_at, email, display_name) VALUES (?, ?, ?, ?, ?)')
        .bind(u.id, u.now, u.now, u.email ?? null, u.displayName ?? null),
      this.db.prepare('INSERT INTO user_profiles (user_id, updated_at) VALUES (?, ?)').bind(u.id, u.now),
    ]);
  }

  findUser(id: string): Promise<UserRow | null> {
    return first<UserRow>(
      this.db.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').bind(id),
    );
  }

  findIdentity(provider: string, subject: string): Promise<IdentityRow | null> {
    return first<IdentityRow>(
      this.db.prepare('SELECT * FROM identities WHERE provider = ? AND subject = ?').bind(provider, subject),
    );
  }

  async deleteIdentity(id: string): Promise<void> {
    await run(this.db.prepare('DELETE FROM identities WHERE id = ?').bind(id));
  }

  listIdentities(userId: string): Promise<IdentityRow[]> {
    return all<IdentityRow>(
      this.db.prepare('SELECT * FROM identities WHERE user_id = ? ORDER BY created_at').bind(userId),
    );
  }

  async addIdentity(i: {
    id: string;
    userId: string;
    provider: 'google';
    subject: string;
    email: string | null;
    now: number;
  }): Promise<void> {
    await run(
      this.db
        .prepare(
          'INSERT INTO identities (id, user_id, provider, subject, email, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        )
        .bind(i.id, i.userId, i.provider, i.subject, i.email, i.now),
    );
  }

  /** Fill in email / name from a sign-in provider without overwriting what the user already set. */
  async fillMissingProfile(
    userId: string,
    email: string | null,
    name: string | null,
    now: number,
  ): Promise<void> {
    await run(
      this.db
        .prepare(
          'UPDATE users SET email = COALESCE(email, ?), display_name = COALESCE(display_name, ?), updated_at = ? WHERE id = ?',
        )
        .bind(email, name, now, userId),
    );
  }

  async insertRefresh(r: Omit<RefreshRow, 'used_at' | 'revoked_at'>): Promise<void> {
    await run(
      this.db
        .prepare(
          'INSERT INTO refresh_tokens (id, user_id, family_id, token_hash, device_label, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
        )
        .bind(r.id, r.user_id, r.family_id, r.token_hash, r.device_label, r.created_at, r.expires_at),
    );
  }

  findRefresh(hash: string): Promise<RefreshRow | null> {
    return first<RefreshRow>(this.db.prepare('SELECT * FROM refresh_tokens WHERE token_hash = ?').bind(hash));
  }

  /** True if this call is the one that spent the token (a concurrent second call gets false). */
  async markRefreshUsed(id: string, now: number): Promise<boolean> {
    return (
      (await run(
        this.db
          .prepare('UPDATE refresh_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL')
          .bind(now, id),
      )) === 1
    );
  }

  revokeFamily(familyId: string, now: number): Promise<number> {
    return run(
      this.db
        .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE family_id = ? AND revoked_at IS NULL')
        .bind(now, familyId),
    );
  }

  revokeAllForUser(userId: string, now: number): Promise<number> {
    return run(
      this.db
        .prepare('UPDATE refresh_tokens SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
        .bind(now, userId),
    );
  }

  deleteExpiredRefresh(before: number): Promise<number> {
    return run(this.db.prepare('DELETE FROM refresh_tokens WHERE expires_at < ?').bind(before));
  }

  countActiveSessions(userId: string, now: number): Promise<{ n: number } | null> {
    return first<{ n: number }>(
      this.db
        .prepare(
          'SELECT COUNT(DISTINCT family_id) AS n FROM refresh_tokens WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?',
        )
        .bind(userId, now),
    );
  }
}
