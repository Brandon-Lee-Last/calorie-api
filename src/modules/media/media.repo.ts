import { first, run } from '../../db/sql';

export type MediaRow = {
  id: string;
  key: string;
  kind: 'video' | 'image' | 'pdf';
  provider: 'r2' | 'stream' | 'external';
  location: string | null;
  mime: string | null;
  bytes: number | null;
  duration_s: number | null;
  width: number | null;
  height: number | null;
  title: string | null;
  tier: 'free' | 'pro';
  created_at: number;
  updated_at: number;
}; // fmt: skip

export type MediaData = Omit<MediaRow, 'id' | 'created_at' | 'updated_at'>;

export class MediaRepo {
  constructor(private db: D1Database) {}

  get(id: string): Promise<MediaRow | null> {
    return first<MediaRow>(this.db.prepare('SELECT * FROM media WHERE id = ?').bind(id));
  }

  getByKey(key: string): Promise<MediaRow | null> {
    return first<MediaRow>(this.db.prepare('SELECT * FROM media WHERE key = ?').bind(key));
  }

  /** Create or update by key (the stable human name), keeping the id that other rows point at. */
  async upsertByKey(id: string, d: MediaData, now: number): Promise<void> {
    await run(
      this.db
        .prepare(
          `INSERT INTO media (id, key, kind, provider, location, mime, bytes, duration_s, width, height, title, tier, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (key) DO UPDATE SET kind = excluded.kind, provider = excluded.provider, location = excluded.location,
             mime = excluded.mime, bytes = excluded.bytes, duration_s = excluded.duration_s, width = excluded.width,
             height = excluded.height, title = excluded.title, tier = excluded.tier, updated_at = excluded.updated_at`,
        )
        .bind(
          id,
          d.key,
          d.kind,
          d.provider,
          d.location,
          d.mime,
          d.bytes,
          d.duration_s,
          d.width,
          d.height,
          d.title,
          d.tier,
          now,
          now,
        ),
    );
  }

  async delete(id: string): Promise<void> {
    await run(this.db.prepare('DELETE FROM media WHERE id = ?').bind(id));
  }
}
