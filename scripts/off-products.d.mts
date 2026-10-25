export type CatalogueFood = {
  source: 'openfoodfacts';
  externalId: string;
  barcode: string;
  name: string;
  brand?: string;
  servingG?: number;
  servingLabel?: string;
  calories100g: number;
  protein100g: number;
  carb100g: number;
  fat100g: number;
  fiber100g?: number;
  sugar100g?: number;
  sodiumMg100g?: number;
};

export function isValidGtin(code: string): boolean;
export function canonicalBarcode(code: string): string;
export function convertOffProduct(
  product: unknown,
): { food: CatalogueFood; skip?: never } | { skip: string; food?: never };
