import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareOffers,
  identifier,
  normalizeProduct,
  number,
  packageSize,
  safeKuperUrl,
} from '../src/index.ts';

const time = '2026-10-10T00:00:00.000Z';

test('Russian package labels, multiple packs and units', () => {
  assert.deepEqual(packageSize('0,5 кг'), { amount: 500, unit: 'g' });
  assert.deepEqual(packageSize('2 х 500 г'), { amount: 1000, unit: 'g' });
  assert.deepEqual(packageSize('1 л'), { amount: 1000, unit: 'ml' });
  assert.deepEqual(packageSize('10 шт.'), { amount: 10, unit: 'piece' });
  assert.equal(packageSize('примерно 1 кг'), null);
  assert.equal(packageSize('0 г'), null);
});

test('no fabricated price, availability or weight for weighted items', () => {
  const p = normalizeProduct(
    { id: 123, name: 'Морковь', price: '49,90', human_volume: '1 кг', price_type: 'per_kilo' },
    '10',
    time,
  );

  assert.equal(p.priceRub, 49.9);
  assert.equal(p.available, null);
  assert.equal(p.packageSize, null);
  assert.equal(p.nutritionPer100, null);
  assert.equal(number('от 100 ₽'), null);
  assert.equal(number(''), null);
  assert.equal(number(NaN), null);
  assert.equal(identifier(9007199254740992), null);
  assert.equal(identifier('39055067663'), '39055067663');
});

test('reject changed schema and unsafe links', () => {
  assert.throws(() => normalizeProduct({ name: 'Milk' }, '1', time), /identity/);
  assert.equal(safeKuperUrl('https://attacker.example/x'), null);
  assert.equal(safeKuperUrl('javascript:alert(1)'), null);
  assert.equal(safeKuperUrl('https://x:y@web.kuper.ru/a'), null);
});

test('unit prices remain grouped by dimension', () => {
  const products = [
    normalizeProduct(
      { id: 1, name: 'A', price: 100, human_volume: '500 г', stock: { available: true } },
      '10',
      time,
    ),
    normalizeProduct(
      { id: 2, name: 'B', price: 150, human_volume: '1 кг', stock: { available: true } },
      '10',
      time,
    ),
    normalizeProduct(
      { id: 3, name: 'C', price: 20, human_volume: '1 л', stock: { available: true } },
      '10',
      time,
    ),
  ];
  const groups = compareOffers(products);

  assert.deepEqual(
    groups[0]!.products.map((p) => p.product.id),
    ['2', '1'],
  );
  assert.equal(groups[0]!.products[0]!.unitPrice, 150);
  assert.equal(groups[1]!.products.length, 1);
});
