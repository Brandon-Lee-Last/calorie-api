import { conflict, validationFailed } from '../../core/errors';
import type { Clock } from '../../core/time';
import type { DietRow, MealRow, MealsRepo } from './meals.repo';
import { dietInputSchema, mealInputSchema, type DietInput, type MealInput } from './meals.schemas';

type Plan = 'free' | 'pro';

/** A stored row read back through its schema; a row that no longer passes (an older format) is skipped, not served. */
function parse<T>(
  schema: { safeParse(v: unknown): { success: true; data: T } | { success: false } },
  body: string,
): T | null {
  try {
    const r = schema.safeParse(JSON.parse(body));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

export class MealsService {
  constructor(
    private repo: MealsRepo,
    private planOf: (userId: string) => Promise<Plan>,
    private clock: Clock,
  ) {}

  private async load() {
    const [dietRows, mealRows] = await Promise.all([this.repo.diets(), this.repo.meals()]);
    const diets = dietRows
      .map((r: DietRow) => ({ row: r, d: parse<DietInput>(dietInputSchema, r.body) }))
      .filter((x): x is { row: DietRow; d: DietInput } => x.d !== null);
    const meals = mealRows
      .map((r: MealRow) => ({ row: r, m: parse<MealInput>(mealInputSchema, r.body) }))
      .filter((x): x is { row: MealRow; m: MealInput } => x.m !== null);
    return { diets, meals, dietRows, mealRows };
  }

  /**
   * Every diet style and meal. On a free account Pro styles are locked, and so is a meal that is only in Pro styles: it
   * keeps its name and numbers (to show what Plus adds) but not its ingredients or steps.
   */
  async plans(userId: string) {
    const plan = await this.planOf(userId);
    const { diets, meals, dietRows, mealRows } = await this.load();
    const free = new Set(diets.filter(({ d }) => d.tier === 'free').map(({ row }) => row.slug));
    const known = new Set(diets.map(({ row }) => row.slug));
    const updated = [...dietRows, ...mealRows].map((r) => r.updated_at);
    return {
      diets: diets.map(({ row, d }) => ({
        slug: row.slug,
        title: d.title,
        summary: d.summary,
        description: d.description,
        tier: d.tier,
        locked: d.tier === 'pro' && plan !== 'pro',
        goals: d.goals,
        highlights: d.highlights,
        split: d.split,
        macros: d.macros,
        caution: d.caution,
        mealCount: meals.filter(({ m }) => m.diets.includes(row.slug)).length,
      })),
      meals: meals.map(({ row, m }) => {
        const locked = plan !== 'pro' && !m.diets.some((s) => free.has(s));
        return {
          slug: row.slug,
          title: m.title,
          summary: m.summary,
          slots: m.slots,
          diets: m.diets.filter((s) => known.has(s)),
          minutes: m.minutes,
          tags: m.tags,
          nutrition: m.nutrition,
          locked,
          ingredients: locked ? [] : m.ingredients,
          steps: locked ? [] : m.steps,
          source: m.source,
        };
      }),
      updatedAt: updated.length ? Math.max(...updated) : null,
    };
  }

  async slugs() {
    const [diets, meals] = await Promise.all([this.repo.diets(), this.repo.meals()]);
    return { diets: diets.map((d) => d.slug), meals: meals.map((m) => m.slug) };
  }

  async putDiet(slug: string, input: DietInput) {
    await this.repo.putDiet(slug, input.tier, input.position, JSON.stringify(input), this.clock.now());
    return { slug };
  }

  /** Every diet a meal names must exist already, so load diets before meals. */
  async putMeal(slug: string, input: MealInput) {
    const known = new Set((await this.repo.diets()).map((d) => d.slug));
    const unknown = input.diets.filter((s) => !known.has(s));
    if (unknown.length) throw validationFailed({ diets: unknown }, `Unknown diet: ${unknown.join(', ')}`);
    await this.repo.putMeal(slug, JSON.stringify(input), this.clock.now());
    return { slug };
  }

  /** A diet still named by a meal cannot go: change or delete those meals first. */
  async deleteDiet(slug: string) {
    const users = (await this.load()).meals
      .filter(({ m }) => m.diets.includes(slug))
      .map(({ row }) => row.slug);
    if (users.length)
      throw conflict(`Meals still use this diet: ${users.slice(0, 10).join(', ')}`, { meals: users });
    await this.repo.deleteDiet(slug);
  }

  async deleteMeal(slug: string) {
    await this.repo.deleteMeal(slug);
  }
}
