import { z } from 'zod';

export const id = z
  .string()
  .regex(/^[1-9]\d{0,19}$/)
  .describe('Numeric Kuper ID as a string, to avoid rounding large IDs');

const text = z.string().trim().min(1).max(200);
const key = z.string().trim().min(1).max(80);

export const unit = z.enum(['g', 'ml', 'piece']);

export const ingredient = z.object({
  id: key,
  name: text,
  query: text,
  amount: z.number().positive().max(10000),
  unit,
});

export const recipe = z.object({
  id: key,
  name: text,
  cuisine: key,
  meal: z.enum(['breakfast', 'lunch', 'dinner']),
  diet: z.array(z.enum(['vegetarian', 'vegan'])).max(2),
  allergens: z.array(key).max(20),
  minutes: z.number().positive().max(300),
  ingredients: z.array(ingredient).min(1).max(30),
  nutrition: z.object({
    kcal: z.number().positive().max(5000),
    protein: z.number().nonnegative().max(500),
    fat: z.number().nonnegative().max(500),
    carbs: z.number().nonnegative().max(1000),
  }),
  instructions: z.array(z.string().max(1000)).max(20),
});

export const recipes = z
  .array(recipe)
  .min(1)
  .max(60)
  .optional()
  .describe(
    'Per-serving recipes. Omit for 15 starter recipes; supply more for restrictive cuisines or diets.',
  );

export const product = z.object({
  id,
  storeId: id,
  name: text,
  priceRub: z.number().nonnegative().max(1000000).nullable(),
  available: z.boolean().nullable(),
  packageSize: z.object({ amount: z.number().positive().max(1000000), unit }).nullable(),
  priceType: z.string().max(80).nullable(),
  volumeLabel: z.string().max(100).nullable(),
  url: z.string().url().max(1000).nullable(),
  observedAt: z.string().datetime(),
  nutritionPer100: z
    .object({
      kcal: z.number().nonnegative(),
      protein: z.number().nonnegative().nullable(),
      fat: z.number().nonnegative().nullable(),
      carbs: z.number().nonnegative().nullable(),
    })
    .nullable(),
});

export const offers = z.array(z.object({ ingredientId: key, product })).max(120);

export const binding = z.object({ ingredientId: key, query: text, productId: id });

export const options = z.object({
  days: z.number().int().min(1).max(7).default(7),
  people: z.number().int().min(1).max(20).default(1),
  budgetRub: z.number().positive().max(1000000),
  dailyKcal: z.number().positive().max(6000),
  calorieTolerance: z.number().min(0).max(0.3).default(0.1),
  cuisines: z.array(key).max(20).optional(),
  diet: z.enum(['any', 'vegetarian', 'vegan']).default('any'),
  excludeIngredients: z.array(key).max(100).optional(),
  excludeAllergens: z.array(key).max(30).optional(),
  maxCookingMinutes: z.number().positive().max(300).optional(),
  minProteinGrams: z.number().positive().max(500).optional(),
  maxFatGrams: z.number().positive().max(500).optional(),
  maxCarbsGrams: z.number().positive().max(1000).optional(),
  maxRecipeRepeats: z.number().int().min(1).max(7).default(3),
  deliveryReserveRub: z.number().nonnegative().max(100000).default(0),
});

export const location = {
  latitude: z.number().min(-90).max(90),
  longitude: z.number().min(-180).max(180),
};

export const query = text;

export const page = z.number().int().min(1).max(50).default(1);

export const selections = z
  .array(z.object({ recipeId: key, portionsPerPerson: z.number().positive().max(10) }))
  .max(93);
