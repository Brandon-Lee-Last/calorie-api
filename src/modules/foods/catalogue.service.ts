import { notFound } from '../../core/errors';
import { newId } from '../../core/ids';
import type { Clock } from '../../core/time';
import { canonicalBarcode, isValidGtin } from '../../lib/barcode';
import { normalizeName } from '../../lib/text';
import type { CatalogueRepo, Normalised } from './catalogue.repo';
import { catalogueFoodSchema } from './catalogue.schemas';

export type ImportResult = {
  created: number;
  updated: number;
  rejected: { index: number; externalId: string | null; reason: string }[];
  warnings: { index: number; externalId: string; message: string }[];
  dryRun: boolean;
};

const round1 = (n: number) => Math.round(n * 10) / 10;

/** Does the stated energy roughly match 4 kcal/g protein and carbohydrate, 9 kcal/g fat? Alcohol and fibre make small gaps normal. */
export function energyGap(f: {
  calories100g: number;
  protein100g: number;
  carb100g: number;
  fat100g: number;
}) {
  const fromMacros = 4 * f.protein100g + 4 * f.carb100g + 9 * f.fat100g;
  const bigger = Math.max(f.calories100g, fromMacros);
  return {
    fromMacros: Math.round(fromMacros),
    mismatch: f.calories100g >= 20 && Math.abs(f.calories100g - fromMacros) / bigger > 0.35,
  };
}

/**
 * Loads sourced nutrition data into the shared catalogue. It checks and stores what it is given and never fills a gap
 * with a guess: a food with no energy figure is rejected, not estimated. Bad rows are reported by position and the good
 * ones still go in.
 */
export class CatalogueService {
  constructor(
    private repo: CatalogueRepo,
    private clock: Clock,
  ) {}

  async import(rawFoods: unknown[], dryRun: boolean): Promise<ImportResult> {
    const result: ImportResult = { created: 0, updated: 0, rejected: [], warnings: [], dryRun };
    const reject = (index: number, externalId: string | null, reason: string) =>
      result.rejected.push({ index, externalId, reason });

    const valid: { index: number; food: Normalised }[] = [];
    const seenKeys = new Set<string>();
    const seenBarcodes = new Map<string, string>();
    rawFoods.forEach((raw, index) => {
      const parsed = catalogueFoodSchema.safeParse(raw);
      const claimedId = (raw as { externalId?: unknown } | null)?.externalId;
      const externalId = typeof claimedId === 'string' ? claimedId : null;
      if (!parsed.success) {
        const issue = parsed.error.issues[0]!;
        return reject(index, externalId, `${issue.path.join('.') || 'food'}: ${issue.message}`);
      }
      const f = parsed.data;
      const key = `${f.source}:${f.externalId}`;
      if (seenKeys.has(key)) return reject(index, f.externalId, 'listed twice in this import');
      if (f.protein100g + f.carb100g + f.fat100g > 102)
        return reject(
          index,
          f.externalId,
          'protein, carbohydrate and fat add up to more than 100 g per 100 g',
        );
      if (f.barcode && !isValidGtin(f.barcode))
        return reject(index, f.externalId, 'barcode: check digit does not match');
      const barcode = f.barcode ? canonicalBarcode(f.barcode) : null;
      if (barcode && seenBarcodes.has(barcode))
        return reject(
          index,
          f.externalId,
          `barcode already used by ${seenBarcodes.get(barcode)} in this import`,
        );
      seenKeys.add(key);
      if (barcode) seenBarcodes.set(barcode, f.externalId);

      const gap = energyGap(f);
      if (gap.mismatch)
        result.warnings.push({
          index,
          externalId: f.externalId,
          message: `energy ${f.calories100g} kcal does not match the macros (about ${gap.fromMacros} kcal): check the source`,
        });
      if (f.sugar100g != null && f.sugar100g > f.carb100g + 0.5)
        result.warnings.push({
          index,
          externalId: f.externalId,
          message: 'sugar is more than carbohydrate: check the source',
        });

      valid.push({
        index,
        food: {
          source: f.source,
          externalId: f.externalId,
          barcode,
          name: f.name,
          nameNorm: normalizeName(f.name),
          brand: f.brand ?? null,
          servingG: f.servingG ?? null,
          servingLabel: f.servingLabel ?? null,
          calories100g: round1(f.calories100g),
          protein100g: round1(f.protein100g),
          carb100g: round1(f.carb100g),
          fat100g: round1(f.fat100g),
          fiber100g: f.fiber100g ?? null,
          sugar100g: f.sugar100g ?? null,
          sodiumMg100g: f.sodiumMg100g ?? null,
          dishId: f.dishId ?? null,
          aliasesNorm: f.aliases?.length
            ? [...new Set(f.aliases.map(normalizeName).filter(Boolean))].join(' | ')
            : null,
        },
      });
    });

    const existingByKey = new Map(
      (await this.repo.byExternalIds(valid.map((v) => v.food.externalId))).map((r) => [
        `${r.source}:${r.external_id}`,
        r,
      ]),
    );
    const barcodeOwners = new Map(
      (await this.repo.byBarcodes(valid.flatMap((v) => (v.food.barcode ? [v.food.barcode] : [])))).map(
        (r) => [r.barcode!, r],
      ),
    );

    const now = this.clock.now();
    const stmts: D1PreparedStatement[] = [];
    for (const { index, food } of valid) {
      const existing = existingByKey.get(`${food.source}:${food.externalId}`);
      const owner = food.barcode ? barcodeOwners.get(food.barcode) : undefined;
      if (owner && owner.id !== existing?.id) {
        reject(index, food.externalId, `barcode already belongs to ${owner.source}:${owner.external_id}`);
        continue;
      }
      if (existing) {
        stmts.push(this.repo.update(existing.id, food, now));
        result.updated++;
      } else {
        stmts.push(this.repo.insert(newId(now), food, now));
        result.created++;
      }
    }
    if (!dryRun) await this.repo.batch(stmts);
    result.rejected.sort((a, b) => a.index - b.index);
    result.warnings.sort((a, b) => a.index - b.index);
    return result;
  }

  async retire(id: string): Promise<void> {
    if (!(await this.repo.retire(id))) throw notFound('Catalogue food');
  }
}
