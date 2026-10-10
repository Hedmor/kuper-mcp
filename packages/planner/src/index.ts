import {
  KuperError,
  positive,
  round,
  type Recipe,
  type Offer,
  type Product,
  type Unit,
} from '@kuper/core';

export interface Selection {
  recipeId: string;
  portionsPerPerson: number;
}

export interface ShoppingItem {
  productId: string;
  storeId: string;
  name: string;
  ingredientIds: string[];
  unit: Unit;
  required: number;
  packages: number;
  purchased: number;
  leftover: number;
  costRub: number;
  observedAt: string;
}

export interface ShoppingResult {
  items: ShoppingItem[];
  totalRub: number;
  missing: string[];
  complete: boolean;
}

const normalize = (value: string) => value.trim().toLocaleLowerCase('ru');

export function validateRecipes(recipes: Recipe[]): void {
  if (!recipes.length || recipes.length > 60) {
    throw new KuperError('INVALID_INPUT', 'Provide 1–60 recipes');
  }

  const ids = new Set<string>();
  const ingredientUnits = new Map<string, Unit>();

  for (const recipe of recipes) {
    if (!recipe.id || ids.has(recipe.id)) {
      throw new KuperError('INVALID_INPUT', 'Recipe IDs must be unique');
    }

    ids.add(recipe.id);

    if (
      !['breakfast', 'lunch', 'dinner'].includes(recipe.meal) ||
      !recipe.ingredients.length ||
      recipe.ingredients.length > 30
    ) {
      throw new KuperError('INVALID_INPUT', 'Invalid recipe meal or ingredients');
    }

    positive(recipe.nutrition.kcal, 'Recipe kcal');
    positive(recipe.minutes, 'Cooking minutes');

    for (const value of [recipe.nutrition.protein, recipe.nutrition.fat, recipe.nutrition.carbs]) {
      if (!Number.isFinite(value) || value < 0) {
        throw new KuperError('INVALID_INPUT', 'Invalid recipe nutrition');
      }
    }

    const local = new Set<string>();

    for (const ingredient of recipe.ingredients) {
      positive(ingredient.amount, 'Ingredient amount');

      if (
        !ingredient.id ||
        local.has(ingredient.id) ||
        !['g', 'ml', 'piece'].includes(ingredient.unit)
      ) {
        throw new KuperError('INVALID_INPUT', 'Invalid or duplicate ingredient');
      }

      local.add(ingredient.id);

      if (
        ingredientUnits.has(ingredient.id) &&
        ingredientUnits.get(ingredient.id) !== ingredient.unit
      ) {
        throw new KuperError('INVALID_INPUT', 'Ingredient units must be consistent');
      }

      ingredientUnits.set(ingredient.id, ingredient.unit);
    }
  }
}

function offerMap(offers: Offer[]): Map<string, Product> {
  if (offers.length > 120) {
    throw new KuperError('INVALID_INPUT', 'At most 120 bindings');
  }

  const map = new Map<string, Product>();
  const productVersions = new Map<string, string>();

  for (const offer of offers) {
    if (map.has(offer.ingredientId)) {
      throw new KuperError('INVALID_INPUT', 'Duplicate ingredient binding: ' + offer.ingredientId);
    }

    const p = offer.product;
    const key = p.storeId + ':' + p.id;
    const signature = JSON.stringify([p.priceRub, p.packageSize, p.available, p.observedAt]);

    if (productVersions.has(key) && productVersions.get(key) !== signature) {
      throw new KuperError('INVALID_INPUT', 'Conflicting snapshots for the same product');
    }

    if (p.priceRub !== null && (!Number.isFinite(p.priceRub) || p.priceRub < 0)) {
      throw new KuperError('INVALID_INPUT', 'Invalid offer price');
    }

    if (p.packageSize) {
      positive(p.packageSize.amount, 'Package size');
    }

    productVersions.set(key, signature);
    map.set(offer.ingredientId, p);
  }

  return map;
}

export function buildShoppingList(
  recipes: Recipe[],
  selections: Selection[],
  offers: Offer[],
  people = 1,
): ShoppingResult {
  validateRecipes(recipes);
  positive(people, 'People');

  if (!Number.isInteger(people) || people > 20 || selections.length > 93) {
    throw new KuperError('INVALID_INPUT', 'Shopping list size exceeded');
  }

  const byId = new Map(recipes.map((r) => [r.id, r]));
  const bindings = offerMap(offers);
  const required = new Map<string, { amount: number; unit: Unit }>();

  for (const selection of selections) {
    const recipe = byId.get(selection.recipeId);

    if (!recipe) {
      throw new KuperError('INVALID_INPUT', 'Unknown recipe: ' + selection.recipeId);
    }

    positive(selection.portionsPerPerson, 'Portions');

    if (selection.portionsPerPerson > 10) {
      throw new KuperError('INVALID_INPUT', 'Too many portions');
    }

    for (const ingredient of recipe.ingredients) {
      const current = required.get(ingredient.id) ?? { amount: 0, unit: ingredient.unit };

      current.amount += ingredient.amount * selection.portionsPerPerson * people;
      required.set(ingredient.id, current);
    }
  }

  const missing: string[] = [];
  const grouped = new Map<
    string,
    { product: Product; amount: number; ids: string[]; unit: Unit }
  >();

  for (const [id, need] of required) {
    const product = bindings.get(id);

    if (
      !product ||
      product.available !== true ||
      product.priceRub === null ||
      !product.packageSize ||
      product.packageSize.unit !== need.unit
    ) {
      missing.push(id);

      continue;
    }

    const key = product.storeId + ':' + product.id;
    const group = grouped.get(key) ?? { product, amount: 0, ids: [], unit: need.unit };

    group.amount += need.amount;
    group.ids.push(id);
    grouped.set(key, group);
  }

  const items = [...grouped.values()].map(({ product, amount, ids, unit }): ShoppingItem => {
    const size = product.packageSize!.amount;
    // Сначала суммируем потребность, затем округляем упаковки; epsilon убирает погрешность float.
    const packages = Math.ceil(amount / size - 1e-10);
    const purchased = packages * size;

    return {
      productId: product.id,
      storeId: product.storeId,
      name: product.name,
      ingredientIds: ids,
      unit,
      required: round(amount),
      packages,
      purchased: round(purchased),
      leftover: round(purchased - amount),
      costRub: round(packages * product.priceRub!),
      observedAt: product.observedAt,
    };
  });

  return {
    items,
    totalRub: round(items.reduce((total, item) => total + item.costRub, 0)),
    missing,
    complete: missing.length === 0,
  };
}

export interface PlanOptions {
  days?: number;
  people?: number;
  budgetRub: number;
  dailyKcal: number;
  calorieTolerance?: number;
  cuisines?: string[];
  diet?: 'any' | 'vegetarian' | 'vegan';
  excludeIngredients?: string[];
  excludeAllergens?: string[];
  maxCookingMinutes?: number;
  minProteinGrams?: number;
  maxFatGrams?: number;
  maxCarbsGrams?: number;
  maxRecipeRepeats?: number;
  deliveryReserveRub?: number;
}

interface State {
  selections: Selection[];
  counts: Record<string, number>;
  cost: number;
  penalty: number;
}

export function planWeek(recipes: Recipe[], offers: Offer[], options: PlanOptions) {
  validateRecipes(recipes);
  offerMap(offers);

  const days = options.days ?? 7;
  const people = options.people ?? 1;
  const tolerance = options.calorieTolerance ?? 0.1;
  const maxRepeats = options.maxRecipeRepeats ?? 3;

  if (
    !Number.isInteger(days) ||
    days < 1 ||
    days > 7 ||
    !Number.isInteger(people) ||
    people < 1 ||
    people > 20 ||
    !Number.isInteger(maxRepeats) ||
    maxRepeats < 1 ||
    maxRepeats > 7
  ) {
    throw new KuperError('INVALID_INPUT', 'Invalid days, people, or repeats');
  }

  positive(options.budgetRub, 'Budget');
  positive(options.dailyKcal, 'Daily kcal');

  if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > 0.3) {
    throw new KuperError('INVALID_INPUT', 'Calorie tolerance must be 0–0.3');
  }

  const reserve = options.deliveryReserveRub ?? 0;

  if (!Number.isFinite(reserve) || reserve < 0) {
    throw new KuperError('INVALID_INPUT', 'Invalid delivery reserve');
  }

  for (const value of [
    options.minProteinGrams,
    options.maxFatGrams,
    options.maxCarbsGrams,
    options.maxCookingMinutes,
  ]) {
    if (value !== undefined) {
      positive(value, 'Macro/time constraint');
    }
  }

  const cuisines = (options.cuisines ?? []).map(normalize);
  const excluded = (options.excludeIngredients ?? []).map(normalize);
  const allergens = (options.excludeAllergens ?? []).map(normalize);
  const eligible = recipes.filter(
    (r) =>
      (!cuisines.length || cuisines.includes(normalize(r.cuisine))) &&
      (!options.diet || options.diet === 'any' || r.diet.includes(options.diet)) &&
      (!options.maxCookingMinutes || r.minutes <= options.maxCookingMinutes) &&
      !r.allergens.some((a) => allergens.includes(normalize(a))) &&
      !r.ingredients.some(
        (i) => excluded.includes(normalize(i.id)) || excluded.includes(normalize(i.name)),
      ) &&
      buildShoppingList(recipes, [{ recipeId: r.id, portionsPerPerson: 1 }], offers, people)
        .complete,
  );
  const meals = ['breakfast', 'lunch', 'dinner'] as const;
  const fractions = [0.25, 0.4, 0.35];
  const candidates = meals.map((meal) => eligible.filter((r) => r.meal === meal));

  if (candidates.some((list) => !list.length)) {
    return {
      status: 'insufficient_data' as const,
      reason: 'No fully priced recipe for each meal under the chosen filters',
      missingMeals: meals.filter((_, i) => !candidates[i]!.length),
      shoppingList: null,
      days: [],
      constraintsMet: false,
    };
  }

  let states: State[] = [{ selections: [], counts: {}, cost: 0, penalty: 0 }];

  function nutrition(selections: Selection[]) {
    return selections.reduce(
      (sum, s) => {
        const r = recipes.find((r) => r.id === s.recipeId)!;

        for (const key of ['kcal', 'protein', 'fat', 'carbs'] as const) {
          sum[key] += r.nutrition[key] * s.portionsPerPerson;
        }

        return sum;
      },
      { kcal: 0, protein: 0, fat: 0, carbs: 0 },
    );
  }

  function dayPenalty(n: ReturnType<typeof nutrition>) {
    return (
      Math.max(0, Math.abs(n.kcal - options.dailyKcal) / options.dailyKcal - tolerance) * 1000 +
      (options.minProteinGrams
        ? (Math.max(0, options.minProteinGrams - n.protein) / options.minProteinGrams) * 1000
        : 0) +
      (options.maxFatGrams
        ? (Math.max(0, n.fat - options.maxFatGrams) / options.maxFatGrams) * 1000
        : 0) +
      (options.maxCarbsGrams
        ? (Math.max(0, n.carbs - options.maxCarbsGrams) / options.maxCarbsGrams) * 1000
        : 0)
    );
  }

  for (let day = 0; day < days; day++) {
    for (let meal = 0; meal < meals.length; meal++) {
      const next: State[] = [];

      for (const state of states) {
        for (const recipe of candidates[meal]!) {
          const count = Object.hasOwn(state.counts, recipe.id) ? state.counts[recipe.id]! : 0;

          if (count >= maxRepeats) {
            continue;
          }

          // Ограничиваем размер порции; недостижимые цели не выдаём за выполненные.
          const portions = round(
            Math.max(
              0.5,
              Math.min(2, (options.dailyKcal * fractions[meal]!) / recipe.nutrition.kcal),
            ),
          );
          const selections = [
            ...state.selections,
            { recipeId: recipe.id, portionsPerPerson: portions },
          ];
          const cost = buildShoppingList(recipes, selections, offers, people).totalRub;

          next.push({
            selections,
            counts: { ...state.counts, [recipe.id]: count + 1 },
            cost,
            penalty:
              state.penalty +
              (meal === 2 ? dayPenalty(nutrition(selections.slice(-3))) : 0) +
              count * 0.15,
          });
        }
      }

      if (!next.length) {
        return {
          status: 'constraints_not_met' as const,
          reason:
            'No plan found within recipe repetition limits; provide more recipes or increase maxRecipeRepeats',
          shoppingList: null,
          days: [],
          constraintsMet: false,
        };
      }

      const score = (s: State) =>
        s.penalty +
        (Math.max(0, s.cost + reserve - options.budgetRub) / options.budgetRub) * 10000 +
        s.cost / options.budgetRub;

      states = next.sort((a, b) => score(a) - score(b)).slice(0, 48);
    }
  }

  const best = states[0]!;
  const shoppingList = buildShoppingList(recipes, best.selections, offers, people);
  const daily = Array.from({ length: days }, (_, day) => {
    const selections = best.selections.slice(day * 3, day * 3 + 3);
    const values = nutrition(selections);

    return {
      day: day + 1,
      meals: selections.map((s) => ({ ...s, recipe: recipes.find((r) => r.id === s.recipeId)! })),
      nutritionPerPerson: Object.fromEntries(Object.entries(values).map(([k, v]) => [k, round(v)])),
      constraintsMet: dayPenalty(values) < 1e-8,
    };
  });
  const total = round(shoppingList.totalRub + reserve);
  const constraintsMet =
    shoppingList.complete && total <= options.budgetRub && daily.every((d) => d.constraintsMet);
  const stores = [...new Set(shoppingList.items.map((i) => i.storeId))];

  return {
    status: constraintsMet ? ('feasible' as const) : ('constraints_not_met' as const),
    constraintsMet,
    days: daily,
    people,
    shoppingList,
    budget: {
      limitRub: options.budgetRub,
      productsRub: shoppingList.totalRub,
      deliveryReserveRub: reserve,
      totalRub: total,
      remainingRub: round(options.budgetRub - total),
    },
    algorithm: { name: 'bounded-beam-search', beamWidth: 48, optimalityGuaranteed: false },
    warnings: [
      'Recipe calories and macros are estimates per serving, scaled per person; they are not laboratory measurements.',
      'Delivery fees, minimum order values, service charges, discounts, and current inventory must be checked before ordering.',
      'Allergen and diet filters use recipe tags; verify product labels and ingredient substitutions.',
      ...(stores.length > 1
        ? ['Products span multiple stores; the delivery reserve must cover each store.']
        : []),
      ...(!constraintsMet
        ? [
            'This bounded search did not find a compliant plan; it does not prove that no plan exists.',
          ]
        : []),
    ],
  };
}
