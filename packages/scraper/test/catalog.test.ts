import test from 'node:test';
import assert from 'node:assert/strict';
import { KuperCatalog, CatalogTransport, environmentOptions } from '../src/index.ts';
import type { HttpSession } from '../src/transport.ts';

function catalog(body: unknown) {
  const session: HttpSession = {
    request: async (path) => ({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
      url: 'https://kuper.ru' + path,
      retryAfter: null,
    }),
    close: async () => {},
  };

  return new KuperCatalog(new CatalogTransport(session, { intervalMs: 0 }));
}

test('city filtering and address-specific store metadata', async () => {
  const cities = catalog({
    app_configuration: {
      cities: [
        { id: 28, name: 'Москва' },
        { id: 99, name: 'Новосибирск' },
      ],
    },
  });

  assert.equal((await cities.listCities('ново')).cities[0]!.name, 'Новосибирск');
  await cities.close();

  const stores = catalog({ stores: [{ id: 10, retailer: { name: 'Магазин', slug: 'shop' } }] });
  const result = await stores.listStores(55, 82);

  assert.equal(result.stores[0]!.id, '10');
  assert.equal(result.nextPage, null);
  await stores.close();
});

test('schema changes are surfaced instead of fabricated empty results', async () => {
  const cat = catalog({ wrong: [] });

  await assert.rejects(cat.searchProducts('10', 'молоко'), /collection/);
  await assert.rejects(cat.listCities(), /collection/);
  await cat.close();
});

test('pagination uses API metadata even when a page contains fewer than 24 products', async () => {
  const products = [{ id: 1, name: 'Meat', stock: 59 }];
  const cat = catalog({ products, meta: { current_page: 1, next_page: 2, total_pages: 25 } });
  assert.equal((await cat.searchProducts('10', 'meat')).nextPage, 2);
  await cat.close();
  const last = catalog({
    products: Array.from({ length: 24 }, () => products[0]),
    meta: { next_page: null },
  });
  assert.equal((await last.searchProducts('10', 'meat')).nextPage, null);
  await last.close();
  const invalid = catalog({ products, meta: { next_page: 1 } });
  await assert.rejects(invalid.searchProducts('10', 'meat'), /pagination/);
  await invalid.close();
});

test('candidate matching never selects an ingredient automatically', async () => {
  const cat = catalog({
    products: [
      { id: 1, name: 'Рис', price: 100, human_volume: '500 г', stock: { available: true } },
      {
        id: 2,
        name: 'Рисовое молоко',
        price: 150,
        human_volume: '1 л',
        stock: { available: true },
      },
    ],
  });
  const result = await cat.matchIngredients('10', [{ id: 'rice', query: 'рис', unit: 'g' }]);

  assert.equal(result.results[0]!.requiresSemanticReview, true);
  assert.equal(result.results[0]!.candidates.length, 1);
  await assert.rejects(
    cat.resolveBindings('10', [{ ingredientId: 'rice', query: 'рис', productId: '123' }]),
    /page 1/,
  );
  await cat.close();
});

test('validate HTTP configuration before opening a session', () => {
  assert.equal(environmentOptions({}).transport.origin, 'https://kuper.ru');
  assert.equal(environmentOptions({}).transport.intervalMs, 1500);
  assert.equal(environmentOptions({}).transport.ttlMs, 300000);
  assert.equal(environmentOptions({}).timeoutMs, 30000);
  assert.equal(environmentOptions({ KUPER_CACHE_TTL_MS: '0' }).transport.ttlMs, 0);
  for (const value of ['999', '60001', 'invalid', '1.5', '']) {
    assert.throws(
      () => environmentOptions({ KUPER_TIMEOUT_MS: value }),
      /Invalid KUPER_TIMEOUT_MS/,
    );
  }
  assert.throws(() => environmentOptions({ KUPER_MIN_INTERVAL_MS: '1' }), /Invalid/);
});
