import { KuperError } from '@kuper/core';

export interface HttpReply {
  status: number;
  contentType: string;
  body: string;
  retryAfter: string | null;
  url: string;
}

export interface HttpSession {
  request(path: string): Promise<HttpReply>;
  close(): Promise<void>;
}

export interface TransportOptions {
  origin?: string;
  intervalMs?: number;
  ttlMs?: number;
  maxCacheEntries?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function retryAfterMs(value: string | null, now = Date.now()): number {
  if (!value) {
    return 5000;
  }

  const seconds = Number(value);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;

  return Number.isFinite(ms) ? Math.max(1000, ms) : 5000;
}

const allowedRoutes = new Set([
  '/api/v2/app_configuration',
  '/api/v2/stores',
  '/api/v2/products',
  '/api/v2/gorodok/api/v2/addresses/suggests',
]);

export class CatalogTransport {
  private cache = new Map<string, { expires: number; data: unknown; observedAt: string }>();
  private inFlight = new Map<
    string,
    Promise<{ data: unknown; observedAt: string; cached: boolean }>
  >();
  private tail: Promise<unknown> = Promise.resolve();
  private lastRequest: number | null = null;
  private cooldownUntil = 0;
  private closed = false;
  private resetting = false;
  private lastError: { code: string; observedAt: string } | null = null;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly interval: number;
  private readonly ttl: number;
  private readonly session: HttpSession;
  private readonly options: TransportOptions;

  constructor(session: HttpSession, options: TransportOptions = {}) {
    this.session = session;
    this.options = options;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.interval = options.intervalMs ?? 1500;
    this.ttl = options.ttlMs ?? 300000;

    for (const value of [this.interval, this.ttl, options.maxCacheEntries ?? 256]) {
      if (!Number.isFinite(value) || value < 0) {
        throw new KuperError('INVALID_CONFIG', 'Invalid scraping limits');
      }
    }
  }

  async get(path: string, params: Record<string, string | number> = {}) {
    if (this.closed) {
      throw new KuperError('CLOSED', 'Scraper is closed');
    }

    if (this.resetting) {
      throw new KuperError('BUSY', 'HTTP session reset is in progress');
    }

    if (!allowedRoutes.has(path)) {
      throw new KuperError('INVALID_ROUTE', 'Only catalog routes are permitted');
    }

    const search = new URLSearchParams(
      Object.entries(params)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, String(v)]),
    );
    const key = path + (search.size ? '?' + search.toString() : '');
    const cached = this.cache.get(key);

    if (cached && cached.expires > this.now()) {
      return { data: cached.data, observedAt: cached.observedAt, cached: true };
    }

    if (this.inFlight.has(key)) {
      return this.inFlight.get(key)!;
    }

    if (this.inFlight.size >= 16) {
      throw new KuperError('BUSY', 'Scraping queue is full');
    }

    const task = this.tail.then(async () => {
      try {
        const result = await this.fetch(key);
        this.lastError = null;
        return result;
      } catch (error) {
        this.lastError = {
          code: error instanceof KuperError ? error.code : 'HTTP_CLIENT_ERROR',
          observedAt: new Date(this.now()).toISOString(),
        };
        throw error;
      }
    });

    // Ошибка запроса не должна останавливать последовательную очередь.
    this.tail = task.catch(() => {});
    this.inFlight.set(key, task);

    try {
      return await task;
    } finally {
      this.inFlight.delete(key);
    }
  }

  private async request(path: string): Promise<HttpReply> {
    if (this.cooldownUntil > this.now()) {
      throw new KuperError(
        'RATE_LIMITED',
        'Kuper requested a cooldown',
        this.cooldownUntil - this.now(),
      );
    }

    if (this.lastRequest !== null) {
      await this.sleep(Math.max(0, this.lastRequest + this.interval - this.now()));
    }

    this.lastRequest = this.now();

    try {
      return await this.session.request(path);
    } catch (error) {
      // Ошибка клиента тоже может содержать лимит: сохраняем общий cooldown.
      if (error instanceof KuperError && error.code === 'RATE_LIMITED') {
        this.cooldownUntil = this.now() + (error.retryAfterMs ?? 5000);
      }
      throw error;
    }
  }

  private check(reply: HttpReply): void {
    if (reply.status === 429) {
      const delay = retryAfterMs(reply.retryAfter, this.now());

      this.cooldownUntil = this.now() + delay;

      throw new KuperError('RATE_LIMITED', 'Kuper returned 429; retry after cooldown', delay);
    }

    if ([401, 403].includes(reply.status) || (reply.status >= 300 && reply.status < 400)) {
      const vpnPolicy =
        reply.status === 403 && /vpn/i.test(reply.body) && /отключите/i.test(reply.body);
      throw new KuperError(
        'SESSION_REQUIRED',
        vpnPolicy
          ? 'Kuper returned HTTP 403 with its VPN/network policy page; session reset does not resolve this network restriction'
          : 'Kuper denied this session (HTTP ' +
              reply.status +
              '); check network access and retry later',
      );
    }

    if (reply.status >= 500) {
      throw new KuperError('UPSTREAM_UNAVAILABLE', 'Kuper is temporarily unavailable');
    }

    if (reply.status < 200 || reply.status >= 300) {
      throw new KuperError('UPSTREAM_HTTP', 'Kuper returned HTTP ' + reply.status);
    }

    const url = new URL(reply.url);

    if (url.origin !== (this.options.origin ?? 'https://kuper.ru')) {
      throw new KuperError('SESSION_REQUIRED', 'Kuper redirected outside the catalog origin');
    }
  }

  private async fetch(key: string) {
    if (this.closed) {
      throw new KuperError('CLOSED', 'Scraper is closed');
    }

    // HTTP-транспорт обращается только к разрешённым маршрутам каталога.
    let reply: HttpReply | undefined;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        reply = await this.request(key);
        this.check(reply);

        break;
      } catch (error) {
        if (
          !(error instanceof KuperError) ||
          !['UPSTREAM_UNAVAILABLE', 'NETWORK_TIMEOUT'].includes(error.code) ||
          attempt === 2
        ) {
          throw error;
        }

        await this.sleep(1000 * 2 ** attempt + Math.floor(Math.random() * 250));
      }
    }

    if (!reply || !reply.contentType.toLowerCase().includes('json')) {
      throw new KuperError(
        'SESSION_REQUIRED',
        'Expected JSON; possible site challenge or expired session',
      );
    }

    let data: unknown;

    try {
      data = JSON.parse(reply.body);
    } catch {
      throw new KuperError('SCHEMA_CHANGED', 'Kuper returned invalid JSON');
    }

    const observedAt = new Date(this.now()).toISOString();
    const max = this.options.maxCacheEntries ?? 256;

    if (max > 0) {
      if (this.cache.size >= max) {
        this.cache.delete(this.cache.keys().next().value!);
      }

      this.cache.set(key, { data, observedAt, expires: this.now() + this.ttl });
    }

    return { data, observedAt, cached: false };
  }

  async resetSession() {
    if (this.closed) {
      throw new KuperError('CLOSED', 'Scraper is closed');
    }
    if (this.resetting || this.inFlight.size) {
      throw new KuperError(
        'BUSY',
        'Wait for pending requests before resetting the session session',
      );
    }
    this.resetting = true;
    const task = (async () => {
      await this.session.close();
      this.cache.clear();
      this.lastError = null;
      // Сброс сессии не отменяет паузу и ограничения частоты запросов.
    })();
    this.tail = task.catch(() => {});
    try {
      await task;
    } finally {
      this.resetting = false;
    }
    return this.status();
  }

  status() {
    return {
      origin: this.options.origin ?? 'https://kuper.ru',
      closed: this.closed,
      resetting: this.resetting,
      lastError: this.lastError,
      sessionBlocked: this.lastError?.code === 'SESSION_REQUIRED',
      pending: this.inFlight.size,
      cacheEntries: this.cache.size,
      intervalMs: this.interval,
      cacheTtlMs: this.ttl,
      cooldownMs: Math.max(0, this.cooldownUntil - this.now()),
    };
  }

  async close() {
    this.closed = true;
    await this.tail;
    this.cache.clear();
    await this.session.close();
  }
}
