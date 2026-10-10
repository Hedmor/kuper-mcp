import { createCatalog } from './index.ts';

const catalog = createCatalog();

try {
  const lat = Number(process.env.KUPER_SMOKE_LAT);
  const lon = Number(process.env.KUPER_SMOKE_LON);

  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    throw new Error('Set KUPER_SMOKE_LAT and KUPER_SMOKE_LON to exact delivery coordinates');
  }

  const stores = await catalog.listStores(lat, lon);

  console.error(JSON.stringify(stores, null, 2));

  if (!stores.stores[0]) {
    throw new Error('No stores found');
  }

  const products = await catalog.searchProducts(stores.stores[0].id, 'молоко');

  console.error(JSON.stringify(products, null, 2));

  if (!products.products.length) {
    throw new Error('Live search returned no products');
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Smoke failed');
  process.exitCode = 1;
} finally {
  await catalog.close();
}
