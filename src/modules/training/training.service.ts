import { hmacSha256Base64Url } from '../../core/crypto';
import { notFound } from '../../core/errors';
import { decodeCursor, encodeCursor, toPage } from '../../core/pagination';
import type { ObjectStorage } from '../media/object-storage';
import type { ContributionRow, TrainingRepo } from './training.repo';

const typeOf = (key: string) =>
  key.endsWith('.png')
    ? ('image/png' as const)
    : key.endsWith('.webp')
      ? ('image/webp' as const)
      : ('image/jpeg' as const);

const positive = (n: number | null) => (n !== null && n > 0 ? n : null);

/**
 * Photos that people chose to contribute, for training the next model. What leaves here carries no user id: `donor` is a keyed
 * hash that is the same for one person's photos (so the training split can keep a person on one side) and cannot be traced
 * back. Labels are what the person *kept*, not measurements, so the export script gives them a low training weight.
 */
export class TrainingService {
  constructor(
    private repo: TrainingRepo,
    private storage: ObjectStorage,
    private secret: string,
  ) {}

  private donor(userId: string) {
    return hmacSha256Base64Url(this.secret, `donor:${userId}`).then((h) => h.slice(0, 16));
  }

  private async toItem(r: ContributionRow) {
    const kept = r.outcome === 'saved' || r.outcome === 'edited';
    return {
      id: r.id,
      donor: await this.donor(r.user_id),
      createdAt: r.created_at,
      modelVersion: r.model_version,
      outcome: r.outcome,
      /** `food`: the person kept a result. `not_food`: the person said it was not food. `unlabelled`: they discarded it. */
      kind:
        r.outcome === 'not_food' ? ('not_food' as const) : kept ? ('food' as const) : ('unlabelled' as const),
      predictedCalories: r.pred_calories,
      label: kept
        ? {
            calories: positive(r.final_calories),
            massG: positive(r.final_mass_g),
            fatG: r.final_fat_g,
            carbG: r.final_carb_g,
            proteinG: r.final_protein_g,
            edited: r.outcome === 'edited',
          }
        : null,
      photoType: typeOf(r.image_key),
    }; // fmt: skip
  }

  async list(limit: number, cursor: string | undefined, since: number) {
    const after = decodeCursor<{ t: number; id: string }>(cursor, ['t', 'id']);
    const rows = await this.repo.list(after ? { createdAt: after.t, id: after.id } : null, since, limit + 1);
    const page = toPage(rows, limit, (last) => encodeCursor({ t: last.created_at, id: last.id }));
    return { items: await Promise.all(page.items.map((r) => this.toItem(r))), nextCursor: page.nextCursor };
  }

  /** The photo, only while the person's consent stands and the photo exists. */
  async photo(id: string) {
    const row = await this.repo.get(id);
    const object = row ? await this.storage.get(row.image_key) : null;
    if (!row || !object) throw notFound('Contributed photo');
    return {
      body: object.body,
      type: typeOf(row.image_key),
    };
  }
}
