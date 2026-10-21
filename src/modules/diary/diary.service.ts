import { conflict, notFound } from '../../core/errors';
import { DAY, type Clock } from '../../core/time';
import { assertLoggedTime, assertRangeWithin, sanitizeClientTime } from '../../core/validation';
import type { ObjectStorage } from '../media/object-storage';
import { IMAGE_TYPES, type ImageType } from '../media/object-storage';
import type { DayRow, DiaryRepo, EntryData, EntryRow, RecentRow } from './diary.repo';

export const MAX_SUMMARY_DAYS = 366;
export const MAX_ENTRY_RANGE_DAYS = 62;
export const MAX_PHOTO_BYTES = 3 * 1024 * 1024;
export const RECENT_WINDOW_MS = 60 * DAY;

export type EntryInput = Omit<
  EntryData,
  'foodId' | 'quantityG' | 'servings' | 'fiberG' | 'sugarG' | 'sodiumMg' | 'scanId' | 'note'
> & {
  foodId?: string | null;
  quantityG?: number | null;
  servings?: number | null;
  fiberG?: number | null;
  sugarG?: number | null;
  sodiumMg?: number | null;
  scanId?: string | null;
  note?: string | null;
  clientUpdatedAt: number;
}; // fmt: skip

export const toEntry = (r: EntryRow) => ({
  id: r.id,
  loggedAt: r.logged_at,
  localDate: r.local_date,
  mealType: r.meal_type,
  name: r.name,
  foodId: r.food_id,
  quantityG: r.quantity_g,
  servings: r.servings,
  calories: r.calories,
  proteinG: r.protein_g,
  carbG: r.carb_g,
  fatG: r.fat_g,
  fiberG: r.fiber_g,
  sugarG: r.sugar_g,
  sodiumMg: r.sodium_mg,
  source: r.source as EntrySource,
  scanId: r.scan_id,
  hasPhoto: r.photo_key !== null,
  note: r.note,
  clientUpdatedAt: r.client_updated_at,
  updatedAt: r.updated_at,
  deletedAt: r.deleted_at,
  rev: r.rev,
}); // fmt: skip
type EntrySource = 'scan' | 'manual' | 'food' | 'barcode' | 'ai_text' | 'quick_add';

export const toDay = (d: DayRow, waterMl: number) => ({
  localDate: d.local_date,
  entries: d.entries,
  calories: round(d.calories),
  proteinG: round(d.protein_g),
  carbG: round(d.carb_g),
  fatG: round(d.fat_g),
  fiberG: round(d.fiber_g),
  sugarG: round(d.sugar_g),
  sodiumMg: round(d.sodium_mg),
  waterMl,
}); // fmt: skip
const round = (n: number) => Math.round(n * 10) / 10;

export const toRecent = (r: RecentRow) => ({
  name: r.name,
  mealType: r.meal_type,
  calories: r.calories,
  proteinG: r.protein_g,
  carbG: r.carb_g,
  fatG: r.fat_g,
  quantityG: r.quantity_g,
  servings: r.servings,
  foodId: r.food_id,
  lastLoggedAt: r.last_logged_at,
  timesLogged: r.times,
}); // fmt: skip

export const photoKey = (userId: string, entryId: string, type: ImageType) =>
  `users/${userId}/meals/${entryId}.${IMAGE_TYPES[type]}`;

export class DiaryService {
  constructor(
    private repo: DiaryRepo,
    private storage: ObjectStorage,
    private clock: Clock,
  ) {}

  async put(userId: string, id: string, input: EntryInput) {
    const now = this.clock.now();
    assertLoggedTime(input, now);
    if (await this.repo.taken(userId, id)) throw conflict('That id is already in use');
    const { applied } = await this.repo.upsert(
      userId,
      id,
      {
        loggedAt: input.loggedAt,
        localDate: input.localDate,
        mealType: input.mealType,
        name: input.name,
        foodId: input.foodId ?? null,
        quantityG: input.quantityG ?? null,
        servings: input.servings ?? null,
        calories: input.calories,
        proteinG: input.proteinG,
        carbG: input.carbG,
        fatG: input.fatG,
        fiberG: input.fiberG ?? null,
        sugarG: input.sugarG ?? null,
        sodiumMg: input.sodiumMg ?? null,
        source: input.source,
        scanId: input.scanId ?? null,
        note: input.note ?? null,
      },
      sanitizeClientTime(input.clientUpdatedAt, now),
      now,
    ); // fmt: skip
    return { applied, record: toEntry((await this.repo.get(userId, id))!) };
  }

  async delete(userId: string, id: string, clientUpdatedAt?: number) {
    const now = this.clock.now();
    const before = await this.repo.get(userId, id);
    const result = await this.repo.delete(
      userId,
      id,
      clientUpdatedAt === undefined ? now : sanitizeClientTime(clientUpdatedAt, now),
      now,
    );
    if (result.outcome === 'applied' && before?.photo_key) await this.storage.delete(before.photo_key);
    return result;
  }

  async list(userId: string, from: string, to: string) {
    assertRangeWithin(from, to, MAX_ENTRY_RANGE_DAYS);
    return { items: (await this.repo.list(userId, from, to)).map(toEntry) };
  }

  /** Per-day totals; days with only water appear too. */
  async summary(userId: string, from: string, to: string) {
    assertRangeWithin(from, to, MAX_SUMMARY_DAYS);
    const [days, water] = await Promise.all([
      this.repo.daySummary(userId, from, to),
      this.repo.waterByDay(userId, from, to),
    ]);
    const waterByDate = new Map(water.map((w) => [w.local_date, w.ml]));
    const out = days.map((d) => toDay(d, waterByDate.get(d.local_date) ?? 0));
    const have = new Set(days.map((d) => d.local_date));
    for (const [date, ml] of waterByDate) {
      if (!have.has(date)) {
        out.push(
          toDay(
            {
              local_date: date,
              entries: 0,
              calories: 0,
              protein_g: 0,
              carb_g: 0,
              fat_g: 0,
              fiber_g: 0,
              sugar_g: 0,
              sodium_mg: 0,
            },
            ml,
          ),
        );
      }
    }
    return { days: out.sort((a, b) => a.localDate.localeCompare(b.localDate)) };
  }

  async recent(userId: string, limit: number) {
    return {
      items: (await this.repo.recent(userId, this.clock.now() - RECENT_WINDOW_MS, limit)).map(toRecent),
    };
  }

  async setPhoto(userId: string, id: string, upload: { bytes: Uint8Array; type: ImageType }) {
    const entry = await this.repo.get(userId, id);
    if (!entry || entry.deleted_at !== null) throw notFound('Diary entry');
    const key = photoKey(userId, id, upload.type);
    await this.storage.put(key, upload.bytes, upload.type);
    if (entry.photo_key && entry.photo_key !== key) await this.storage.delete(entry.photo_key);
    await this.repo.setPhotoKey(userId, id, key, this.clock.now());
    return toEntry((await this.repo.get(userId, id))!);
  }

  async getPhoto(userId: string, id: string) {
    const entry = await this.repo.get(userId, id);
    if (!entry || entry.deleted_at !== null || !entry.photo_key) throw notFound('Photo');
    const object = await this.storage.get(entry.photo_key);
    if (!object) throw notFound('Photo');
    return object;
  }

  async deletePhoto(userId: string, id: string) {
    const entry = await this.repo.get(userId, id);
    if (!entry || entry.deleted_at !== null || !entry.photo_key) return;
    await this.storage.delete(entry.photo_key);
    await this.repo.setPhotoKey(userId, id, null, this.clock.now());
  }
}
