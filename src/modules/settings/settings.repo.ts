import { all, run } from '../../db/sql';

export class SettingsRepo {
  constructor(private db: D1Database) {}

  async list(): Promise<Record<string, string>> {
    const rows = await all<{ key: string; value: string }>(
      this.db.prepare('SELECT key, value FROM app_settings'),
    );
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  }

  async set(key: string, value: string, now: number): Promise<void> {
    await run(
      this.db
        .prepare(
          'INSERT INTO app_settings (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
        )
        .bind(key, value, now),
    );
  }

  async remove(key: string): Promise<void> {
    await run(this.db.prepare('DELETE FROM app_settings WHERE key = ?').bind(key));
  }
}
