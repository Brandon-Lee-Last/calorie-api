# Meal plans

The app plans a day of meals (breakfast, lunch, dinner, one or two snacks) in a diet style the person picks, with portions scaled to
their calorie goal. The server only serves the content (`GET /v1/meal-plans`); the planning happens on the phone, so it works offline.

## Styles

| Style         | Plan | Built on                                                                                                   |
| ------------- | ---- | ---------------------------------------------------------------------------------------------------------- |
| Balanced      | Free | South Africa's food-based dietary guidelines: starch at most meals, legumes often, plenty of veg and fruit |
| Budget        | Free | Affordable staples: maize meal, oats, beans, lentils, eggs, pilchards, chicken pieces, cabbage             |
| High protein  | Pro  | At least 25% of each meal's energy from protein (ISSN: 1.4–2 g/kg a day, 20–40 g a meal)                   |
| Mediterranean | Pro  | Olive oil, fish twice a week, legumes, vegetables, whole grains, nuts                                      |
| Low carb      | Pro  | At most 25% of each meal's energy from carbohydrate (moderate, not keto)                                   |
| Vegetarian    | Pro  | No meat or fish                                                                                            |
| Plant-based   | Pro  | No animal foods (no eggs, dairy or honey)                                                                  |

Why these: every big nutrition app puts most plans behind its subscription and keeps a standard balanced plan free (Lifesum, Yazio,
MyFitnessPal). Long trials (for example DIRECT, NEJM 2008) find that the style matters less than sticking to it, so the point of
offering several is to let people pick one they will keep. Budget is free because cost is the first barrier for many South Africans.

Safety, shown in the app with each style: low carb tells people on insulin, sulphonylureas or SGLT2 inhibitors to talk to their doctor
first (doses may need changing); plant-based says to take vitamin B12; high protein mentions kidney disease. Plans never go below the
calorie goal, which the server already keeps above a safe floor. Plans are general guidance, not medical nutrition therapy.

## Content

`content/meal-plans/`:

- `ingredients.json`: every ingredient with its figures per 100 g as eaten (`kcal`, `protein`, `carb`, `fat`, `fibre`), the USDA food
  they come from (`fdc` id, or `usda` description until the id is known), what it is (`kind`: plant, meat, fish, egg, dairy, honey), its
  shop `aisle`, and `pricey: true` for things the Budget plan avoids.
- `diets/*.json`: one style each (`split` is each meal's share of the day; `macros` is the guidance shown).
- `meals/*.json`: title, `slots`, `diets`, minutes, ingredients as `{ id, grams, measure }` for one portion, and steps.

The importer works out each meal's nutrition from its ingredients, so a meal's numbers are never typed by hand.

`scripts/meal-content.test.mjs` (part of `npm run check`) holds the content to its promises: high-protein meals get at least 25% of
their energy from protein, low-carb meals at most 25% from carbs, vegetarian meals have no meat or fish, plant-based meals only plants,
budget meals nothing pricey, every diet has at least 5 breakfasts, lunches and dinners and 4 snacks, and every figure adds up the way
the server checks (4 kcal/g protein and carbs, 9 kcal/g fat, within 15%).

`scripts/check-ingredients.mjs` compares every ingredient with USDA's own files (Publish content runs it before publishing): kcal must be
within 3% (or 5 kcal), the rest within 5% (or 0.5 g). It prints USDA's figures as JSON lines to paste back, and the closest USDA foods
for one it cannot find. South African foods USDA does not have use the nearest match and say so in their name (hake uses Atlantic cod;
lean biltong uses dried beef; boerewors uses fresh beef sausage).

## Adding a meal

1. Add any new ingredients to `ingredients.json` with a `usda` description, and run Publish content (or push): the check prints the
   USDA figures and id to paste in.
2. Add `meals/<slug>.json`. Keep a portion near a typical plate (breakfast 300–450 kcal, lunch 350–500, dinner 400–600, snack 80–250):
   the app scales it from half to double.
3. `npm run test:scripts`, then push to `main`.
