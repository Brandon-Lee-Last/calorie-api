import { conflict, notFound, validationFailed } from '../../core/errors';
import { newId } from '../../core/ids';
import type { Clock } from '../../core/time';
import { sanitizeClientTime } from '../../core/validation';
import { canonicalBarcode, isValidGtin } from '../../lib/barcode';
import { normalizeName } from '../../lib/text';
import type { FoodRow, FoodsRepo } from './foods.repo';
import type { FoodLookup } from './off';

export type FoodInput = {
  name: string;
  brand?: string | null;
  barcode?: string | null;
  servingG?: number | null;
  servingLabel?: string | null;
  calories100g: number;
  protein100g: number;
  carb100g: number;
  fat100g: number;
  fiber100g?: number | null;
  sugar100g?: number | null;
  sodiumMg100g?: number | null;
  clientUpdatedAt: number;
}; // fmt: skip

const r1 = (n: number) => Math.round(n * 10) / 10;

export function toFood(r: FoodRow, viewerId: string) {
  const per = r.serving_g
    ? {
        calories: r1((r.calories_100g * r.serving_g) / 100),
        proteinG: r1((r.protein_100g * r.serving_g) / 100),
        carbG: r1((r.carb_100g * r.serving_g) / 100),
        fatG: r1((r.fat_100g * r.serving_g) / 100),
      }
    : null;
  return {
    id: r.id,
    source: r.source,
    isOwn: r.user_id === viewerId,
    barcode: r.barcode,
    name: r.name,
    brand: r.brand,
    servingG: r.serving_g,
    servingLabel: r.serving_label,
    calories100g: r.calories_100g,
    protein100g: r.protein_100g,
    carb100g: r.carb_100g,
    fat100g: r.fat_100g,
    fiber100g: r.fiber_100g,
    sugar100g: r.sugar_100g,
    sodiumMg100g: r.sodium_mg_100g,
    perServing: per,
    clientUpdatedAt: r.client_updated_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    rev: r.rev,
  }; // fmt: skip
}

export class FoodsService {
  constructor(
    private repo: FoodsRepo,
    private lookup: FoodLookup,
    private clock: Clock,
  ) {}

  async putCustom(userId: string, id: string, input: FoodInput) {
    const now = this.clock.now();
    if (input.barcode && !isValidGtin(input.barcode)) {
      throw validationFailed([
        { path: 'barcode', message: 'Not a valid barcode (check digit does not match)' },
      ]);
    }
    if (await this.repo.takenByAnother(userId, id)) throw conflict('That id is already in use');
    const data = {
      name: input.name,
      nameNorm: normalizeName(input.name),
      brand: input.brand ?? null,
      barcode: input.barcode ? canonicalBarcode(input.barcode) : null,
      servingG: input.servingG ?? null,
      servingLabel: input.servingLabel ?? null,
      calories100g: input.calories100g,
      protein100g: input.protein100g,
      carb100g: input.carb100g,
      fat100g: input.fat100g,
      fiber100g: input.fiber100g ?? null,
      sugar100g: input.sugar100g ?? null,
      sodiumMg100g: input.sodiumMg100g ?? null,
    }; // fmt: skip
    try {
      const { applied } = await this.repo.upsertCustom(
        userId,
        id,
        data,
        sanitizeClientTime(input.clientUpdatedAt, now),
        now,
      );
      return { applied, record: toFood((await this.repo.getOwn(userId, id))!, userId) };
    } catch (e) {
      if (e instanceof Error && /UNIQUE/i.test(e.message))
        throw conflict('You already have a food with this barcode');
      throw e;
    }
  }

  deleteCustom(userId: string, id: string, clientUpdatedAt?: number) {
    const now = this.clock.now();
    return this.repo.deleteCustom(
      userId,
      id,
      clientUpdatedAt === undefined ? now : sanitizeClientTime(clientUpdatedAt, now),
      now,
      clientUpdatedAt === undefined, // a direct DELETE is the person acting now: always applies
    );
  }

  async get(userId: string, id: string) {
    const own = await this.repo.getOwn(userId, id);
    if (own && own.deleted_at === null) return toFood(own, userId);
    const shared = await this.repo.getCatalogue(id);
    if (!shared) throw notFound('Food');
    return toFood(shared, userId);
  }

  async search(userId: string, q: string, limit: number) {
    const tokens = normalizeName(q).split(' ').filter(Boolean).slice(0, 5);
    if (tokens.length === 0) return { items: [] };
    return { items: (await this.repo.search(userId, tokens, limit)).map((r) => toFood(r, userId)) };
  }

  /** Own food with this barcode, else the shared catalogue, else ask Open Food Facts and remember the answer. */
  async byBarcode(userId: string, code: string) {
    if (!isValidGtin(code))
      throw validationFailed([{ path: 'code', message: 'Not a valid barcode (check digit does not match)' }]);
    const barcode = canonicalBarcode(code);
    const own = await this.repo.findOwnByBarcode(userId, barcode);
    if (own) return toFood(own, userId);
    const cached = await this.repo.findCatalogueByBarcode(barcode);
    if (cached) return toFood(cached, userId);

    const found = await this.lookup.findByBarcode(barcode);
    if (!found) throw notFound('Product');
    await this.repo.cacheExternal(
      newId(this.clock.now()),
      found,
      normalizeName(found.name),
      this.clock.now(),
    );
    const saved = await this.repo.findCatalogueByBarcode(barcode);
    return toFood(saved!, userId);
  }
}
