import {
  collection,
  identifier,
  KuperError,
  normalizeProduct,
  record,
  type Product,
} from '@kuper/core';
import { CatalogTransport } from './transport.ts';
import { HttpcloakSession, HTTP_CATALOG_ORIGIN } from './httpcloak.ts';

export { CatalogTransport, retryAfterMs } from './transport.ts';

export { HttpcloakSession } from './httpcloak.ts';

export function environmentOptions(env: NodeJS.ProcessEnv) {
  const integer = (name: string, fallback: number, min: number, max: number) => {
    if (env[name] === undefined) {
      return fallback;
    }

    const value = Number(env[name]);

    if (!Number.isInteger(value) || value < min || value > max) {
      throw new KuperError('INVALID_CONFIG', 'Invalid ' + name);
    }

    return value;
  };

  return {
    timeoutMs: integer('KUPER_TIMEOUT_MS', 30000, 1000, 60000),
    transport: {
      origin: HTTP_CATALOG_ORIGIN,
      intervalMs: integer('KUPER_MIN_INTERVAL_MS', 1500, 1000, 60000),
      ttlMs: integer('KUPER_CACHE_TTL_MS', 300000, 0, 3600000),
    },
  };
}

function validateLocation(latitude: number, longitude: number) {
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    throw new KuperError('INVALID_INPUT', 'Invalid delivery coordinates');
  }
}

function validateQuery(query: string) {
  if (!query.trim() || query.length > 200) {
    throw new KuperError('INVALID_INPUT', 'Query must contain 1–200 characters');
  }
}

function validatePage(page: number) {
  if (!Number.isInteger(page) || page < 1 || page > 50) {
    throw new KuperError('INVALID_INPUT', 'Page must be 1–50');
  }
}

export class KuperCatalog {
  private readonly transport: CatalogTransport;

  constructor(transport: CatalogTransport) {
    this.transport = transport;
  }

  async listCities(query = '') {
    const result = await this.transport.get('/api/v2/app_configuration');
    const root = record(result.data);
    const config = record(root.app_configuration ?? root.data ?? root);
    // Не подставляем вымышленные города или координаты при изменении схемы API.
    const cities = collection(config, 'cities')
      .map((value) => {
        const city = record(value);
        const id = identifier(city.id);

        if (!id || typeof city.name !== 'string') {
          throw new KuperError('SCHEMA_CHANGED', 'Invalid city in configuration');
        }

        return { id, name: city.name };
      })
      .filter((city) => city.name.toLocaleLowerCase('ru').includes(query.toLocaleLowerCase('ru')))
      .slice(0, 100);

    return {
      observedAt: result.observedAt,
      cached: result.cached,
      cities,
      note:
        'City list is from app configuration; if absent, use a known cityId and exact delivery ' +
        'coordinates. Availability is address-specific.',
    };
  }

  async suggestAddresses(cityId: string, query: string) {
    if (!identifier(cityId)) {
      throw new KuperError('INVALID_INPUT', 'Invalid cityId');
    }

    validateQuery(query);

    const result = await this.transport.get('/api/v2/gorodok/api/v2/addresses/suggests', {
      city_id: cityId,
      q: query,
    });
    const suggests = collection(result.data, 'suggests')
      .slice(0, 20)
      .map((value) => {
        const row = record(value);

        return {
          id: row.id ?? null,
          address: row.address ?? row.value ?? row.name ?? null,
          latitude: row.lat ?? row.latitude ?? null,
          longitude: row.lon ?? row.longitude ?? null,
        };
      });

    return {
      suggests,
      observedAt: result.observedAt,
      cached: result.cached,
      note: 'Coordinates may be absent in this API response. Supply exact delivery coordinates to list_stores.',
    };
  }

  async listStores(latitude: number, longitude: number, page = 1) {
    validateLocation(latitude, longitude);
    validatePage(page);

    const result = await this.transport.get('/api/v2/stores', {
      lat: latitude,
      lon: longitude,
      page,
      per_page: 24,
      shipping_method: 'delivery',
    });
    const stores = collection(result.data, 'stores').map((value) => {
      const row = record(value);
      const retailer = record(row.retailer);
      const id = identifier(row.id);

      if (!id) {
        throw new KuperError('SCHEMA_CHANGED', 'Invalid store ID');
      }

      return {
        id,
        name:
          typeof row.name === 'string'
            ? row.name
            : typeof retailer.name === 'string'
              ? retailer.name
              : null,
        retailerSlug: typeof retailer.slug === 'string' ? retailer.slug : null,
      };
    });

    return {
      stores,
      page,
      nextPage: stores.length === 24 ? page + 1 : null,
      observedAt: result.observedAt,
      cached: result.cached,
      location: { latitude, longitude },
      note: 'Store presence does not guarantee a delivery slot or minimum order.',
    };
  }

  async searchProducts(storeId: string, query: string, page = 1, sort = 'popularity') {
    if (!identifier(storeId)) {
      throw new KuperError('INVALID_INPUT', 'Invalid storeId');
    }

    validateQuery(query);
    validatePage(page);

    if (!['popularity', 'price_asc', 'price_desc', 'unit_price_asc'].includes(sort)) {
      throw new KuperError('INVALID_INPUT', 'Invalid sort');
    }

    const result = await this.transport.get('/api/v2/products', {
      sid: storeId,
      q: query,
      page,
      per_page: 24,
      sort,
    });
    const products = collection(result.data, 'products').map((raw) =>
      normalizeProduct(raw, storeId, result.observedAt),
    );
    const root = record(result.data);
    const meta = record(root.meta ?? record(root.data).meta);
    let nextPage = products.length === 24 ? page + 1 : null;
    if (Object.hasOwn(meta, 'next_page')) {
      if (meta.next_page === null) {
        nextPage = null;
      } else if (
        typeof meta.next_page === 'number' &&
        Number.isInteger(meta.next_page) &&
        meta.next_page > page
      ) {
        nextPage = meta.next_page;
      } else {
        throw new KuperError('SCHEMA_CHANGED', 'Invalid product pagination metadata');
      }
    }

    return {
      products,
      storeId,
      query,
      page,
      nextPage,
      observedAt: result.observedAt,
      cached: result.cached,
    };
  }

  async searchCityProducts(latitude: number, longitude: number, query: string, maxStores = 3) {
    validateLocation(latitude, longitude);
    validateQuery(query);

    if (!Number.isInteger(maxStores) || maxStores < 1 || maxStores > 5) {
      throw new KuperError('INVALID_INPUT', 'Use 1–5 stores');
    }

    const location = await this.listStores(latitude, longitude);
    const results: unknown[] = [];

    for (const store of location.stores.slice(0, maxStores)) {
      try {
        results.push({ store, ...(await this.searchProducts(store.id, query)) });
      } catch (error) {
        if (
          !(error instanceof KuperError) ||
          ['RATE_LIMITED', 'SESSION_REQUIRED'].includes(error.code)
        ) {
          throw error;
        }

        results.push({ store, error: { code: error.code, message: error.message } });
      }
    }

    return {
      location: { latitude, longitude },
      query,
      results,
      storesChecked: results.length,
      truncated: location.stores.length > maxStores || location.nextPage !== null,
    };
  }

  async matchIngredients(
    storeId: string,
    ingredients: { id: string; query: string; unit: string }[],
  ) {
    if (!ingredients.length || ingredients.length > 30) {
      throw new KuperError('INVALID_INPUT', 'Use 1–30 ingredients');
    }

    const results = [];

    for (const ingredient of ingredients) {
      const search = await this.searchProducts(storeId, ingredient.query, 1, 'unit_price_asc');
      const candidates = search.products
        .filter(
          (p) =>
            p.available === true && p.priceRub !== null && p.packageSize?.unit === ingredient.unit,
        )
        .slice(0, 8);

      results.push({
        ingredientId: ingredient.id,
        query: ingredient.query,
        candidates,
        requiresSemanticReview: true,
        searchPage: 1,
        nextPage: search.nextPage,
      });
    }

    return {
      storeId,
      results,
      note: 'Select a productId after checking ingredient identity and label. Search results alone do not verify suitability.',
    };
  }

  async resolveBindings(
    storeId: string,
    bindings: { ingredientId: string; query: string; productId: string }[],
  ) {
    if (
      !bindings.length ||
      bindings.length > 30 ||
      new Set(bindings.map((b) => b.ingredientId)).size !== bindings.length
    ) {
      throw new KuperError('INVALID_INPUT', 'Use 1–30 unique ingredient bindings');
    }

    const offers: { ingredientId: string; product: Product }[] = [];

    for (const binding of bindings) {
      const result = await this.searchProducts(storeId, binding.query);
      const product = result.products.find((p) => p.id === binding.productId);

      if (!product) {
        throw new KuperError(
          'PRODUCT_NOT_FOUND',
          'Selected product not on search page 1 for ' +
            binding.ingredientId +
            '; re-run search and update binding',
        );
      }

      offers.push({ ingredientId: binding.ingredientId, product });
    }

    return offers;
  }

  resetSession() {
    return this.transport.resetSession();
  }

  status() {
    return this.transport.status();
  }

  close() {
    return this.transport.close();
  }
}

export function createCatalog(env: NodeJS.ProcessEnv = process.env) {
  const options = environmentOptions(env);

  return new KuperCatalog(
    new CatalogTransport(new HttpcloakSession(options.timeoutMs), options.transport),
  );
}
