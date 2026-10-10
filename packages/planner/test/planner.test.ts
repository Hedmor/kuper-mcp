import test from 'node:test';
import assert from 'node:assert/strict';
import { buildShoppingList, planWeek } from '../src/index.ts';
import { starterRecipes } from '../src/recipes.ts';
import type { Offer, Product, Recipe } from '@kuper/core';

const p: Product = {
  id: '1',
  storeId: '10',
  name: 'Rice',
  priceRub: 100,
  available: true,
  packageSize: { amount: 500, unit: 'g' },
  priceType: null,
  volumeLabel: '500 г',
  url: null,
  observedAt: '2026-10-10T00:00:00.000Z',
  nutritionPer100: null,
};

const base: Recipe = {
  id: 'r',
  name: 'Rice',
  cuisine: 'test',
  meal: 'breakfast',
  diet: ['vegan', 'vegetarian'],
  allergens: [],
  minutes: 10,
  ingredients: [{ id: 'rice', name: 'Rice', query: 'Rice', amount: 300, unit: 'g' }],
  nutrition: { kcal: 500, protein: 20, fat: 10, carbs: 70 },
  instructions: [],
};

const offers: Offer[] = [{ ingredientId: 'rice', product: p }];

test('aggregate first, round packages once, preserve leftovers', () => {
  const list = buildShoppingList(
    [base],
    [
      { recipeId: 'r', portionsPerPerson: 1 },
      { recipeId: 'r', portionsPerPerson: 1 },
    ],
    offers,
    1,
  );

  assert.equal(list.totalRub, 200);
  assert.equal(list.items[0]!.packages, 2);
  assert.equal(list.items[0]!.required, 600);
  assert.equal(list.items[0]!.leftover, 400);
});

test('same SKU mapped to multiple ingredients is charged once', () => {
  const r = {
    ...base,
    ingredients: [...base.ingredients, { ...base.ingredients[0]!, id: 'rice2', amount: 100 }],
  };
  const list = buildShoppingList(
    [r],
    [{ recipeId: 'r', portionsPerPerson: 1 }],
    [...offers, { ingredientId: 'rice2', product: p }],
  );

  assert.equal(list.items.length, 1);
  assert.equal(list.totalRub, 100);
  assert.equal(list.items[0]!.required, 400);
});

test('unknown availability, mismatched units and missing prices yield incomplete list', () => {
  for (const product of [
    { ...p, available: null },
    { ...p, priceRub: null },
    { ...p, packageSize: { amount: 500, unit: 'ml' as const } },
  ]) {
    const result = buildShoppingList(
      [base],
      [{ recipeId: 'r', portionsPerPerson: 1 }],
      [{ ingredientId: 'rice', product }],
    );

    assert.equal(result.complete, false);
    assert.deepEqual(result.missing, ['rice']);
  }
});

test('validate duplicates, conflicting snapshots, negative budget and nonfinite amounts', () => {
  assert.throws(
    () =>
      buildShoppingList([base], [{ recipeId: 'r', portionsPerPerson: 1 }], [...offers, ...offers]),
    /Duplicate/,
  );

  const other = { ...base, id: 's', ingredients: [{ ...base.ingredients[0]!, id: 'rice2' }] };

  assert.throws(
    () =>
      buildShoppingList(
        [base, other],
        [],
        [...offers, { ingredientId: 'rice2', product: { ...p, priceRub: 90 } }],
      ),
    /Conflicting/,
  );
  assert.throws(() => planWeek([base], offers, { budgetRub: -1, dailyKcal: 2000 }), /positive/);
  assert.throws(
    () =>
      buildShoppingList(
        [{ ...base, ingredients: [{ ...base.ingredients[0]!, amount: Infinity }] }],
        [],
        offers,
      ),
    /positive/,
  );
});

const menu: Recipe[] = [
  base,
  { ...base, id: 'l', meal: 'lunch', nutrition: { ...base.nutrition, kcal: 800 } },
  { ...base, id: 'd', meal: 'dinner', nutrition: { ...base.nutrition, kcal: 700 } },
];

test('three meals, people scaling, daily macros, package budget and delivery reserve', () => {
  const result = planWeek(menu, offers, {
    days: 2,
    people: 2,
    budgetRub: 1000,
    dailyKcal: 2000,
    maxRecipeRepeats: 2,
    deliveryReserveRub: 50,
  });

  assert.equal(result.status, 'feasible');
  assert.equal(result.days.length, 2);

  if (!('budget' in result)) {
    throw new Error('Expected full plan');
  }

  assert.equal(result.budget.productsRub, 800);
  assert.equal(result.budget.totalRub, 850);
  assert.equal(result.days[0]!.nutritionPerPerson.kcal, 2000);
});

test('unsatisfied budget or protein never reported as feasible', () => {
  const budget = planWeek(menu, offers, { days: 1, budgetRub: 10, dailyKcal: 2000 });

  assert.equal(budget.constraintsMet, false);

  const protein = planWeek(menu, offers, {
    days: 1,
    budgetRub: 1000,
    dailyKcal: 2000,
    minProteinGrams: 150,
  });

  assert.equal(protein.constraintsMet, false);
});

test('filters and repetitions fail explicitly', () => {
  assert.equal(
    planWeek(menu, offers, {
      days: 1,
      budgetRub: 1000,
      dailyKcal: 2000,
      excludeIngredients: ['rice'],
    }).status,
    'insufficient_data',
  );
  assert.equal(
    planWeek(menu, offers, { days: 4, budgetRub: 1000, dailyKcal: 2000, maxRecipeRepeats: 3 })
      .status,
    'constraints_not_met',
  );
  assert.equal(
    planWeek(
      menu.map((r) => ({ ...r, allergens: ['soy'] })),
      offers,
      { budgetRub: 1000, dailyKcal: 2000, excludeAllergens: ['soy'] },
    ).status,
    'insufficient_data',
  );
});

test('starter recipes have consistent IDs and units and can form a week with complete offers', () => {
  const all = new Map(starterRecipes.flatMap((r) => r.ingredients).map((i) => [i.id, i]));
  const bindings = [...all.values()].map((i, index) => ({
    ingredientId: i.id,
    product: { ...p, id: String(index + 1), packageSize: { amount: 1000, unit: i.unit } },
  }));
  const result = planWeek(starterRecipes, bindings, {
    days: 7,
    budgetRub: 100000,
    dailyKcal: 2000,
  });

  assert.equal(result.status, 'feasible');
  assert.equal(result.days.length, 7);
});
