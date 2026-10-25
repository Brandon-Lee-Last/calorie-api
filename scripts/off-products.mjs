// Open Food Facts product -> shared catalogue food. Pure (no Node APIs), so the Worker's tests can check it agrees with
// the barcode lookup in src/modules/foods/off.ts, which caches products one at a time under the same key.
//
// Same reading as the barcode lookup: energy as kcal, or kJ / 4.184; the first brand; sodium from grams to mg. Stricter
// than it, because a bulk import has no person checking the result: protein, carbohydrate and fat must all be stated
// (none is assumed to be 0), the numbers must fit the catalogue's limits, and the energy must roughly agree with the
// macros (a kJ figure typed into the kcal box is the usual mistake).

/** GTIN check digit: weights 3,1,3,1... from the right of the number without its check digit. */
export function isValidGtin(code) {
  if (!/^(\d{8}|\d{12}|\d{13}|\d{14})$/.test(code)) return false;
  const digits = [...code].map(Number);
  const check = digits.pop();
  let sum = 0;
  for (let i = digits.length - 1, w = 3; i >= 0; i--, w = w === 3 ? 1 : 3) sum += digits[i] * w;
  return (10 - (sum % 10)) % 10 === check;
}

/** UPC-A is an EAN-13 with a leading zero; one form, so the same product is not stored twice. */
export const canonicalBarcode = (code) => (code.length === 12 ? `0${code}` : code);

const num = (v) => {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
};
const round = (x) => Math.round(x * 100) / 100;
const upTo = (x, max) => (x !== null && x <= max ? round(x) : undefined);

/** `{ food }` ready for POST /v1/admin/foods/import, or `{ skip }` with the reason. */
export function convertOffProduct(product) {
  const code = typeof product?.code === 'string' ? product.code.trim() : '';
  if (!isValidGtin(code)) return { skip: 'no valid barcode' };
  const barcode = canonicalBarcode(code);
  const n = product.nutriments ?? {};
  const kcal =
    num(n['energy-kcal_100g']) ?? (num(n['energy_100g']) !== null ? num(n['energy_100g']) / 4.184 : null);
  const name = [product.product_name, product.product_name_en, product.generic_name].find(
    (v) => typeof v === 'string' && v.trim(),
  );
  if (!name) return { skip: 'no name' };
  if (kcal === null) return { skip: 'no energy figure' };
  if (kcal > 900) return { skip: 'more than 900 kcal per 100 g' };
  const protein = num(n['proteins_100g']);
  const carb = num(n['carbohydrates_100g']);
  const fat = num(n['fat_100g']);
  if (protein === null || carb === null || fat === null)
    return { skip: 'no protein, carbohydrate or fat figure' };
  if (protein > 100 || carb > 100 || fat > 100 || protein + carb + fat > 102)
    return { skip: 'protein, carbohydrate and fat add up to more than 100 g' };
  const alcohol = num(n['alcohol_100g']) ?? 0;
  const fromMacros = 4 * protein + 4 * carb + 9 * fat + 7 * alcohol;
  if (kcal >= 20 && Math.abs(kcal - fromMacros) / Math.max(kcal, fromMacros) > 0.35)
    return { skip: 'energy does not match protein, carbohydrate and fat' };

  const brand =
    typeof product.brands === 'string' && product.brands.trim() ? product.brands.split(',')[0].trim() : '';
  const serving = num(product.serving_quantity);
  const servingLabel =
    typeof product.serving_size === 'string' ? product.serving_size.trim().slice(0, 60) : '';
  const sodiumG = num(n['sodium_100g']);
  const food = {
    source: 'openfoodfacts',
    externalId: barcode,
    barcode,
    name: name.trim().slice(0, 200),
    calories100g: round(kcal),
    protein100g: round(protein),
    carb100g: round(carb),
    fat100g: round(fat),
  };
  if (brand) food.brand = brand.slice(0, 100);
  if (serving !== null && serving > 0 && serving <= 5000) food.servingG = serving;
  if (servingLabel) food.servingLabel = servingLabel;
  const fiber = upTo(num(n['fiber_100g']), 100);
  const sugar = upTo(num(n['sugars_100g']), 100);
  const sodium = upTo(sodiumG === null ? null : sodiumG * 1000, 40000);
  if (fiber !== undefined) food.fiber100g = fiber;
  if (sugar !== undefined) food.sugar100g = sugar;
  if (sodium !== undefined) food.sodiumMg100g = sodium;
  return { food };
}
