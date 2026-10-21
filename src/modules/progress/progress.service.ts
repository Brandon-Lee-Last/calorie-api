import { conflict, notFound, quotaExceeded } from '../../core/errors';
import type { Clock } from '../../core/time';
import { assertLoggedTime, assertRangeWithin, sanitizeClientTime } from '../../core/validation';
import { IMAGE_TYPES, type ImageType, type ObjectStorage } from '../media/object-storage';
import type { z } from '../../core/openapi';
import type { ProgressRepo, ProgressRow } from './progress.repo';
import type { progressInputSchema } from './progress.schemas';

export type ProgressInput = z.infer<typeof progressInputSchema>;
export const MAX_RANGE_DAYS = 1100;
export const MAX_PROGRESS_PHOTO_BYTES = 4 * 1024 * 1024;

export const progressKey = (userId: string, id: string, type: ImageType) =>
  `users/${userId}/progress/${id}.${IMAGE_TYPES[type]}`;

export const toProgress = (r: ProgressRow) => ({
  id: r.id,
  loggedAt: r.logged_at,
  localDate: r.local_date,
  pose: r.pose as 'front' | 'side' | 'back' | 'other',
  weightKg: r.weight_kg,
  note: r.note,
  hasPhoto: r.photo_key !== null,
  clientUpdatedAt: r.client_updated_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
  rev: r.rev,
}); // fmt: skip

export class ProgressService {
  constructor(
    private repo: ProgressRepo,
    private storage: ObjectStorage,
    private clock: Clock,
    /** How many progress photos this person may keep (depends on their plan). */
    private photoLimit: (userId: string) => Promise<number> = async () => Number.MAX_SAFE_INTEGER,
  ) {}

  async put(userId: string, id: string, input: ProgressInput) {
    const now = this.clock.now();
    assertLoggedTime(input, now);
    if (await this.repo.taken(userId, id)) throw conflict('That id is already in use');
    const { applied } = await this.repo.upsert(
      userId,
      id,
      {
        loggedAt: input.loggedAt,
        localDate: input.localDate,
        pose: input.pose,
        weightKg: input.weightKg ?? null,
        note: input.note ?? null,
      },
      sanitizeClientTime(input.clientUpdatedAt, now),
      now,
    ); // fmt: skip
    return { applied, record: toProgress((await this.repo.get(userId, id))!) };
  }

  async delete(userId: string, id: string, clientUpdatedAt?: number) {
    const now = this.clock.now();
    const before = await this.repo.get(userId, id);
    const result = await this.repo.delete(
      userId,
      id,
      clientUpdatedAt === undefined ? now : sanitizeClientTime(clientUpdatedAt, now),
      now,
      clientUpdatedAt === undefined, // a direct DELETE is the person acting now: always applies
    );
    if (result.outcome === 'applied' && before?.photo_key) await this.storage.delete(before.photo_key);
    return result;
  }

  async list(userId: string, from: string, to: string) {
    assertRangeWithin(from, to, MAX_RANGE_DAYS);
    return { items: (await this.repo.list(userId, from, to)).map(toProgress) };
  }

  async setPhoto(userId: string, id: string, upload: { bytes: Uint8Array; type: ImageType }) {
    const row = await this.repo.get(userId, id);
    if (!row || row.deleted_at !== null) throw notFound('Progress entry');
    if (!row.photo_key) {
      const limit = await this.photoLimit(userId);
      if ((await this.repo.countPhotos(userId)) >= limit) throw quotaExceeded('progress_photos', limit);
    }
    const key = progressKey(userId, id, upload.type);
    await this.storage.put(key, upload.bytes, upload.type);
    if (row.photo_key && row.photo_key !== key) await this.storage.delete(row.photo_key);
    await this.repo.setPhotoKey(userId, id, key, this.clock.now());
    return toProgress((await this.repo.get(userId, id))!);
  }

  async getPhoto(userId: string, id: string) {
    const row = await this.repo.get(userId, id);
    if (!row || row.deleted_at !== null || !row.photo_key) throw notFound('Photo');
    const object = await this.storage.get(row.photo_key);
    if (!object) throw notFound('Photo');
    return object;
  }

  async deletePhoto(userId: string, id: string) {
    const row = await this.repo.get(userId, id);
    if (!row || row.deleted_at !== null || !row.photo_key) return;
    await this.storage.delete(row.photo_key);
    await this.repo.setPhotoKey(userId, id, null, this.clock.now());
  }
}
