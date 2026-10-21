import { describe, expect, it } from 'vitest';
import { OpenFoodFactsClient, mapOffProduct } from './off';

const product = (over: Record<string, unknown> = {}, nutriments: Record<string, unknown> = {}) => ({
  product_name: 'Crunchy Peanut Butter',
  brands: 'Sunny, Other',
  serving_size: '2 tbsp (32 g)',
  serving_quantity: '32',
  nutriments: {
    'energy-kcal_100g': 600,
    proteins_100g: 25,
    carbohydrates_100g: 12,
    fat_100g: 50,
    fiber_100g: 6,
    sugars_100g: 5,
    sodium_100g: 0.4,
    ...nutriments,
  },
  ...over,
}); // fmt: skip

describe('mapOffProduct', () => {
  it('maps the nutrition per 100 g, converting sodium to mg and keeping the first brand', () => {
    expect(mapOffProduct('3017620422003', product())).toEqual({
      source: 'openfoodfacts',
      externalId: '3017620422003',
      barcode: '3017620422003',
      name: 'Crunchy Peanut Butter',
      brand: 'Sunny',
      servingG: 32,
      servingLabel: '2 tbsp (32 g)',
      calories100g: 600,
      protein100g: 25,
      carb100g: 12,
      fat100g: 50,
      fiber100g: 6,
      sugar100g: 5,
      sodiumMg100g: 400,
    }); // fmt: skip
  });
  it('falls back to kilojoules when kcal is missing', () => {
    const f = mapOffProduct('1', product({}, { 'energy-kcal_100g': undefined, energy_100g: 2092 }));
    expect(f!.calories100g).toBe(500);
  });
  it('gives up on products with no energy, a nonsense energy figure or no name', () => {
    expect(mapOffProduct('1', product({}, { 'energy-kcal_100g': undefined }))).toBeNull();
    expect(mapOffProduct('1', product({}, { 'energy-kcal_100g': 4000 }))).toBeNull();
    expect(mapOffProduct('1', product({ product_name: '  ' }))).toBeNull();
    expect(mapOffProduct('1', undefined)).toBeNull();
  });
  it('treats missing macros as zero and missing extras as unknown', () => {
    const f = mapOffProduct('1', {
      product_name: 'Water biscuit',
      nutriments: { 'energy-kcal_100g': '430' },
    });
    expect(f).toMatchObject({
      calories100g: 430,
      protein100g: 0,
      carb100g: 0,
      fat100g: 0,
      fiber100g: null,
      sugar100g: null,
      sodiumMg100g: null,
      brand: null,
      servingG: null,
    });
  });
  it('ignores negative or non-numeric values and silly serving sizes', () => {
    const f = mapOffProduct(
      '1',
      product({ serving_quantity: '-5' }, { proteins_100g: 'lots', fat_100g: -3 }),
    );
    expect(f).toMatchObject({ protein100g: 0, fat100g: 0, servingG: null });
  });
  it('falls back to another name field', () => {
    expect(mapOffProduct('1', product({ product_name: '', product_name_en: 'English name' }))!.name).toBe(
      'English name',
    );
  });
});

const respond = (status: number, json?: unknown): typeof fetch =>
  (async () => new Response(json === undefined ? 'oops' : JSON.stringify(json), { status })) as never;

describe('OpenFoodFactsClient', () => {
  it('asks for the product with a descriptive user agent and maps it', async () => {
    let seen: { url: string; ua: string } | undefined;
    const fetcher = (async (url: string, init: RequestInit) => {
      seen = { url, ua: (init.headers as Record<string, string>)['user-agent']! };
      return new Response(JSON.stringify({ status: 1, product: product() }));
    }) as never;
    const out = await new OpenFoodFactsClient('CalorieApp/1 (me@example.com)', fetcher).findByBarcode(
      '3017620422003',
    );
    expect(out!.name).toBe('Crunchy Peanut Butter');
    expect(seen!.url).toContain('/api/v2/product/3017620422003.json');
    expect(seen!.ua).toBe('CalorieApp/1 (me@example.com)');
  });
  it('returns null for unknown products', async () => {
    expect(await new OpenFoodFactsClient('ua', respond(404, {})).findByBarcode('1')).toBeNull();
    expect(await new OpenFoodFactsClient('ua', respond(200, { status: 0 })).findByBarcode('1')).toBeNull();
  });
  it('reports an outage as a 502, never as "not found"', async () => {
    const attempts: [typeof fetch][] = [
      [respond(500, {})],
      [respond(503, {})],
      [respond(200)], // not JSON
      [
        (async () => {
          throw new Error('network down');
        }) as never,
      ],
    ]; // fmt: skip
    for (const [f] of attempts) {
      await expect(new OpenFoodFactsClient('ua', f).findByBarcode('1')).rejects.toMatchObject({
        status: 502,
        code: 'upstream_failed',
      });
    }
  });
});
