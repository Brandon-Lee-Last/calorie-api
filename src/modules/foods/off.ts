import { upstreamFailed } from '../../core/errors';
import { globalFetch } from '../../core/fetch';

export type ExternalFood = {
  source: 'openfoodfacts';
  externalId: string;
  barcode: string;
  name: string;
  brand: string | null;
  servingG: number | null;
  servingLabel: string | null;
  calories100g: number;
  protein100g: number;
  carb100g: number;
  fat100g: number;
  fiber100g: number | null;
  sugar100g: number | null;
  sodiumMg100g: number | null;
};

export interface FoodLookup {
  findByBarcode(barcode: string): Promise<ExternalFood | null>;
}

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
};

/**
 * Map an Open Food Facts product to our shape. Returns null when the product has no usable energy figure: a food with
 * no calories is worse than no food. Energy comes as kcal, or kJ as a fallback (1 kcal = 4.184 kJ). Sodium is in grams.
 */
export function mapOffProduct(
  barcode: string,
  product: Record<string, unknown> | undefined,
): ExternalFood | null {
  if (!product) return null;
  const n = (product.nutriments ?? {}) as Record<string, unknown>;
  const kcal =
    num(n['energy-kcal_100g']) ?? (num(n['energy_100g']) !== null ? num(n['energy_100g'])! / 4.184 : null);
  const name = [product.product_name, product.product_name_en, product.generic_name].find(
    (v) => typeof v === 'string' && v.trim(),
  ) as string | undefined;
  if (kcal === null || kcal > 950 || !name) return null; // nothing beats pure fat at ~900 kcal/100g, so more is a data error
  const sodiumG = num(n['sodium_100g']);
  const serving = num(product.serving_quantity);
  const brand =
    typeof product.brands === 'string' && product.brands.trim() ? product.brands.split(',')[0]!.trim() : null;
  return {
    source: 'openfoodfacts',
    externalId: barcode,
    barcode,
    name: name.trim().slice(0, 200),
    brand: brand ? brand.slice(0, 100) : null,
    servingG: serving !== null && serving > 0 && serving <= 5000 ? serving : null,
    servingLabel:
      typeof product.serving_size === 'string' && product.serving_size.trim()
        ? product.serving_size.trim().slice(0, 60)
        : null,
    calories100g: round(kcal),
    protein100g: round(num(n['proteins_100g']) ?? 0),
    carb100g: round(num(n['carbohydrates_100g']) ?? 0),
    fat100g: round(num(n['fat_100g']) ?? 0),
    fiber100g: opt(num(n['fiber_100g'])),
    sugar100g: opt(num(n['sugars_100g'])),
    sodiumMg100g: sodiumG === null ? null : round(sodiumG * 1000),
  };
}
const round = (x: number) => Math.round(x * 100) / 100;
const opt = (x: number | null) => (x === null ? null : round(x));

const FIELDS = 'product_name,product_name_en,generic_name,brands,serving_size,serving_quantity,nutriments';

/** Open Food Facts v2 API. Its terms ask for a descriptive User-Agent; the data is ODbL, so the app should credit it. */
export class OpenFoodFactsClient implements FoodLookup {
  private userAgent: string;

  constructor(
    userAgent: string,
    private fetcher: typeof fetch = globalFetch,
    private timeoutMs = 4000,
  ) {
    // A setting pasted with a line break would make every request throw; header values must be one line.
    this.userAgent = userAgent.replace(/[\r\n\t]+/g, ' ').trim() || 'Pango';
  }

  async findByBarcode(barcode: string): Promise<ExternalFood | null> {
    const url = `https://world.openfoodfacts.org/api/v2/product/${encodeURIComponent(barcode)}.json?fields=${FIELDS}`;
    let res: Response;
    try {
      res = await this.fetcher(url, {
        headers: { 'user-agent': this.userAgent, accept: 'application/json' },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (e) {
      const why = e instanceof Error ? `${e.name}: ${e.message}`.slice(0, 160) : 'error';
      console.warn(`Open Food Facts could not be reached: ${why}`);
      throw upstreamFailed('Open Food Facts', `Open Food Facts could not be reached (${why})`);
    }
    if (res.status === 404) return null;
    if (!res.ok) {
      // Say what they answered: a 403 or 429 means they are refusing this server, not that they are down.
      console.warn(`Open Food Facts answered HTTP ${res.status}`);
      throw upstreamFailed('Open Food Facts', `Open Food Facts answered HTTP ${res.status}`);
    }
    let data: { status?: number; product?: Record<string, unknown> };
    try {
      data = (await res.json()) as typeof data;
    } catch {
      throw upstreamFailed('Open Food Facts');
    }
    if (data.status === 0) return null;
    return mapOffProduct(barcode, data.product);
  }
}
