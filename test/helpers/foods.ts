import { upstreamFailed } from '../../src/core/errors';
import type { ExternalFood, FoodLookup } from '../../src/modules/foods/off';

export const NUTELLA_LIKE: ExternalFood = {
  source: 'openfoodfacts',
  externalId: '4006381333931',
  barcode: '4006381333931',
  name: 'Hazelnut Spread',
  brand: 'Acme',
  servingG: 15,
  servingLabel: '1 tbsp (15 g)',
  calories100g: 539,
  protein100g: 6.3,
  carb100g: 57.5,
  fat100g: 30.9,
  fiber100g: null,
  sugar100g: 56.3,
  sodiumMg100g: 41,
}; // fmt: skip

/** A fake Open Food Facts: serves what it was given, counts calls, and can be told to fail. */
export class FakeLookup implements FoodLookup {
  calls: string[] = [];
  fail = false;
  constructor(private products: Record<string, ExternalFood> = {}) {}
  add(f: ExternalFood) {
    this.products[f.barcode] = f;
  }
  async findByBarcode(barcode: string) {
    this.calls.push(barcode);
    if (this.fail) throw upstreamFailed('Open Food Facts');
    return this.products[barcode] ?? null;
  }
}
