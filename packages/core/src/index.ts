export type Unit = 'g' | 'ml' | 'piece';

export interface Product {
  id: string;
  storeId: string;
  name: string;
  priceRub: number | null;
  available: boolean | null;
  packageSize: { amount: number; unit: Unit } | null;
  priceType: string | null;
  volumeLabel: string | null;
  url: string | null;
  observedAt: string;
  nutritionPer100: {
    kcal: number;
    protein: number | null;
    fat: number | null;
    carbs: number | null;
  } | null;
}

export interface Ingredient {
  id: string;
  name: string;
  query: string;
  amount: number;
  unit: Unit;
}

export interface Recipe {
  id: string;
  name: string;
  cuisine: string;
  meal: 'breakfast' | 'lunch' | 'dinner';
  diet: ('vegetarian' | 'vegan')[];
  allergens: string[];
  minutes: number;
  ingredients: Ingredient[];
  nutrition: { kcal: number; protein: number; fat: number; carbs: number };
  instructions: string[];
}

export interface Offer {
  ingredientId: string;
  product: Product;
}

export class KuperError extends Error {
  readonly code: string;
  readonly retryAfterMs: number | undefined;

  constructor(code: string, message: string, retryAfterMs?: number) {
    super(message);
    this.name = 'KuperError';
    this.code = code;
    this.retryAfterMs = retryAfterMs;
  }
}

export const record = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

export function number(v: unknown): number | null {
  if (typeof v === 'string') {
    if (!/^\s*\d+(?:[.,]\d+)?\s*(?:₽|руб\.?)?\s*$/u.test(v)) {
      return null;
    }

    v = Number(v.replace(/\s|₽|руб\.?/gu, '').replace(',', '.'));
  }

  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

export function identifier(v: unknown): string | null {
  if (typeof v === 'number') {
    return Number.isSafeInteger(v) && v > 0 ? String(v) : null;
  }

  return typeof v === 'string' && /^[1-9]\d{0,19}$/.test(v) ? v : null;
}

export function packageSize(label: unknown): Product['packageSize'] {
  if (typeof label !== 'string') {
    return null;
  }

  const match = label
    .trim()
    .toLowerCase()
    .match(/^(?:(\d+)\s*[xх×]\s*)?(\d+(?:[.,]\d+)?)\s*(кг|г|kg|g|мл|ml|л|l|шт\.?|pcs)$/u);

  if (!match) {
    return null;
  }

  const multiplier = Number(match[1] ?? 1);
  const amount = Number(match[2]!.replace(',', '.'));
  const kind = match[3]!;
  const unit: Unit = /^(кг|г|kg|g)$/.test(kind) ? 'g' : /^(мл|ml|л|l)$/.test(kind) ? 'ml' : 'piece';
  const value = amount * multiplier * (/^(кг|kg|л|l)$/.test(kind) ? 1000 : 1);

  return Number.isFinite(value) && value > 0 ? { amount: value, unit } : null;
}

export function safeKuperUrl(v: unknown): string | null {
  if (typeof v !== 'string') {
    return null;
  }

  try {
    const url = new URL(v, 'https://web.kuper.ru');

    return url.protocol === 'https:' &&
      ['kuper.ru', 'web.kuper.ru'].includes(url.hostname) &&
      !url.username &&
      !url.password
      ? url.href
      : null;
  } catch {
    return null;
  }
}

export function normalizeProduct(raw: unknown, storeId: string, observedAt: string): Product {
  const p = record(raw);
  const id = identifier(p.id);
  const stock = record(p.stock);

  if (!id || typeof p.name !== 'string' || !p.name.trim()) {
    throw new KuperError('SCHEMA_CHANGED', 'Invalid product identity in Kuper response');
  }

  const label = typeof p.human_volume === 'string' ? p.human_volume : null;
  const priceType = typeof p.price_type === 'string' ? p.price_type : null;
  // Для весового товара нужен шаг покупки: одной надписи с массой недостаточно.
  const size = priceType === 'per_kilo' ? null : packageSize(label);
  const availability =
    typeof stock.available === 'boolean'
      ? stock.available
      : typeof p.available === 'boolean'
        ? p.available
        : typeof p.stock === 'number' && Number.isFinite(p.stock) && p.stock >= 0
          ? p.stock > 0
          : null;

  return {
    id,
    storeId,
    name: p.name.trim(),
    priceRub: number(p.price),
    available: p.active === false ? false : availability,
    packageSize: size,
    priceType,
    volumeLabel: label,
    url: safeKuperUrl(p.permalink),
    observedAt,
    nutritionPer100: null,
  };
}

export function collection(raw: unknown, key: string): unknown[] {
  const obj = record(raw);
  const nested = record(obj.data);
  const values = obj[key] ?? nested[key];

  if (!Array.isArray(values)) {
    throw new KuperError('SCHEMA_CHANGED', 'Expected collection: ' + key);
  }

  return values;
}

export function positive(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new KuperError('INVALID_INPUT', name + ' must be positive and finite');
  }
}

export function round(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function unitPrice(product: Product): number | null {
  return product.priceRub !== null && product.packageSize
    ? round(
        (product.priceRub / product.packageSize.amount) *
          (product.packageSize.unit === 'piece' ? 1 : 1000),
      )
    : null;
}

export function compareOffers(products: Product[]) {
  // Сравниваем только одинаковые единицы: ₽/кг, ₽/л и ₽/шт образуют разные группы.
  return (['g', 'ml', 'piece'] as Unit[]).map((unit) => ({
    unit,
    priceBasis: unit === 'g' ? 'RUB/kg' : unit === 'ml' ? 'RUB/l' : 'RUB/piece',
    products: products
      .filter((p) => p.available === true && p.packageSize?.unit === unit && p.priceRub !== null)
      .sort((a, b) => unitPrice(a)! - unitPrice(b)!)
      .map((product) => ({ product, unitPrice: unitPrice(product) })),
  }));
}
