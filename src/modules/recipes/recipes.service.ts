import { conflict, quotaExceeded } from '../../core/errors';
import { decodeCursor, encodeCursor, toPage } from '../../core/pagination';
import type { Clock } from '../../core/time';
import { sanitizeClientTime } from '../../core/validation';
import type { RecipeRow, RecipesRepo } from './recipes.repo';
import type { z } from '../../core/openapi';
import type { ingredientSchema, recipeInputSchema } from './recipes.schemas';

type Ingredient = z.infer<typeof ingredientSchema>;
export type RecipeInput = z.infer<typeof recipeInputSchema>;

const r1 = (n: number) => Math.round(n * 10) / 10;

export function sumIngredients(items: Ingredient[]) {
  const t = items.reduce(
    (a, i) => ({
      calories: a.calories + i.calories,
      proteinG: a.proteinG + i.proteinG,
      carbG: a.carbG + i.carbG,
      fatG: a.fatG + i.fatG,
    }),
    { calories: 0, proteinG: 0, carbG: 0, fatG: 0 },
  ); // fmt: skip
  return { calories: r1(t.calories), proteinG: r1(t.proteinG), carbG: r1(t.carbG), fatG: r1(t.fatG) };
}

export function toRecipe(r: RecipeRow) {
  let ingredients: Ingredient[] = [];
  try {
    ingredients = JSON.parse(r.ingredients) as Ingredient[];
  } catch {
    // stored by this service only, but a damaged row must not take the list down
  }
  const totals = sumIngredients(ingredients);
  const perServing = {
    calories: r1(totals.calories / r.servings),
    proteinG: r1(totals.proteinG / r.servings),
    carbG: r1(totals.carbG / r.servings),
    fatG: r1(totals.fatG / r.servings),
  };
  return {
    id: r.id,
    name: r.name,
    servings: r.servings,
    ingredients,
    totals,
    perServing,
    instructions: r.instructions,
    prepMinutes: r.prep_minutes,
    clientUpdatedAt: r.client_updated_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at,
    rev: r.rev,
  }; // fmt: skip
}

export class RecipesService {
  constructor(
    private repo: RecipesRepo,
    private clock: Clock,
    private recipeLimit: (userId: string) => Promise<number> = async () => Number.MAX_SAFE_INTEGER,
  ) {}

  async put(userId: string, id: string, input: RecipeInput) {
    const now = this.clock.now();
    if (await this.repo.taken(userId, id)) throw conflict('That id is already in use');
    const existing = await this.repo.get(userId, id);
    if (!existing || existing.deleted_at !== null) {
      const limit = await this.recipeLimit(userId);
      if ((await this.repo.count(userId)) >= limit) throw quotaExceeded('recipes', limit);
    }
    const { applied } = await this.repo.upsert(
      userId,
      id,
      {
        name: input.name,
        servings: input.servings,
        ingredients: JSON.stringify(input.ingredients),
        instructions: input.instructions ?? null,
        prepMinutes: input.prepMinutes ?? null,
      },
      sanitizeClientTime(input.clientUpdatedAt, now),
      now,
    ); // fmt: skip
    return { applied, record: toRecipe((await this.repo.get(userId, id))!) };
  }

  delete(userId: string, id: string, clientUpdatedAt?: number) {
    const now = this.clock.now();
    return this.repo.delete(
      userId,
      id,
      clientUpdatedAt === undefined ? now : sanitizeClientTime(clientUpdatedAt, now),
      now,
      clientUpdatedAt === undefined, // a direct DELETE is the person acting now: always applies
    );
  }

  async get(userId: string, id: string) {
    const row = await this.repo.get(userId, id);
    if (!row || row.deleted_at !== null) return null;
    return toRecipe(row);
  }

  async list(userId: string, limit: number, cursor: string | undefined) {
    const after = decodeCursor<{ n: string; id: string }>(cursor, ['n', 'id']);
    const rows = await this.repo.list(userId, after ? { name: after.n, id: after.id } : null, limit + 1);
    const page = toPage(rows, limit, (last) => encodeCursor({ n: last.name, id: last.id }));
    return { items: page.items.map(toRecipe), nextCursor: page.nextCursor };
  }
}
