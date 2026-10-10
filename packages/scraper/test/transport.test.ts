import test from 'node:test';
import assert from 'node:assert/strict';
import { KuperError } from '@kuper/core';
import {
  CatalogTransport,
  retryAfterMs,
  type HttpReply,
  type HttpSession,
} from '../src/transport.ts';

function setup(replies: Partial<HttpReply>[] = []) {
  let now = 100000;
  let closed = false;
  const calls: string[] = [];
  const delays: number[] = [];
  const session: HttpSession = {
    request: async (path) => {
      calls.push(path);

      const raw = replies.shift() ?? { body: '{"products":[]}' };

      return {
        status: 200,
        contentType: 'application/json',
        body: '{}',
        retryAfter: null,
        url: 'https://kuper.ru' + path,
        ...raw,
      };
    },
    close: async () => {
      closed = true;
    },
  };
  const transport = new CatalogTransport(session, {
    intervalMs: 1500,
    ttlMs: 5000,
    now: () => now,
    sleep: async (ms) => {
      delays.push(ms);
      now += ms;
    },
  });

  return {
    transport,
    calls,
    delays,
    advance: (ms: number) => {
      now += ms;
    },
    closed: () => closed,
  };
}

test('coalesce duplicate requests, preserve original timestamp and expire cache', async () => {
  const { transport, calls, advance } = setup();
  const [a, b] = await Promise.all([
    transport.get('/api/v2/products', { sid: 1, q: 'milk' }),
    transport.get('/api/v2/products', { q: 'milk', sid: 1 }),
  ]);

  assert.equal(calls.length, 1);
  assert.equal(a.observedAt, b.observedAt);
  advance(100);

  const cached = await transport.get('/api/v2/products', { sid: 1, q: 'milk' });

  assert.equal(cached.cached, true);
  assert.equal(cached.observedAt, a.observedAt);
  advance(5000);
  await transport.get('/api/v2/products', { sid: 1, q: 'milk' });
  assert.equal(calls.length, 2);
  await transport.close();
});

test('rate limit cooldown and no retry storm', async () => {
  const { transport, calls, advance } = setup([{ status: 429, retryAfter: '10' }]);

  await assert.rejects(
    transport.get('/api/v2/products'),
    (e) => !!e && typeof e === 'object' && 'code' in e && e.code === 'RATE_LIMITED',
  );
  await assert.rejects(transport.get('/api/v2/stores'), /cooldown/);
  assert.equal(calls.length, 1);
  advance(10000);
  await transport.get('/api/v2/stores');
  assert.equal(calls.length, 2);
  await transport.close();
});

test('retry 5xx but stop immediately on challenge', async () => {
  const transient = setup([{ status: 503 }, { status: 502 }, { body: '{"products":[]}' }]);

  await transient.transport.get('/api/v2/products');
  assert.equal(transient.calls.length, 3);
  await transient.transport.close();

  const blocked = setup([{ status: 403 }]);

  await assert.rejects(blocked.transport.get('/api/v2/products'), /denied this session/);
  assert.equal(blocked.calls.length, 1);
  await blocked.transport.close();

  const html = setup([{ contentType: 'text/html', body: '<html>Captcha</html>' }]);

  await assert.rejects(html.transport.get('/api/v2/products'), /Expected JSON/);
  await html.transport.close();
});

test('allowlist, invalid JSON, closure and retry-after dates', async () => {
  const { transport, closed } = setup([{ body: 'invalid' }]);

  await assert.rejects(transport.get('https://evil.example/'), /catalog routes/);
  await assert.rejects(transport.get('/api/v2/products'), /invalid JSON/);
  await transport.close();
  assert.equal(closed(), true);
  await assert.rejects(transport.get('/api/v2/products'), /closed/);
  assert.equal(retryAfterMs('99999', 0), 99999000);
  assert.equal(retryAfterMs('nonsense', 0), 5000);
  assert.equal(retryAfterMs('Thu, 01 Jan 1970 00:00:10 GMT', 0), 10000);
});

test('session failures are visible until a successful network request', async () => {
  const { transport, calls } = setup([{ status: 403 }, { body: '{"products":[]}' }]);
  assert.equal(transport.status().lastError, null);
  await assert.rejects(transport.get('/api/v2/products'), /denied this session/);
  assert.deepEqual(transport.status().lastError, {
    code: 'SESSION_REQUIRED',
    observedAt: new Date(100000).toISOString(),
  });
  assert.equal(transport.status().sessionBlocked, true);
  assert.equal(calls.length, 1);
  await transport.get('/api/v2/products');
  assert.equal(transport.status().lastError, null);
  assert.equal(transport.status().sessionBlocked, false);
  await transport.close();
});

test('reset releases session, invalidates cache, and allows reuse', async () => {
  const { transport, calls, closed } = setup();
  await transport.get('/api/v2/products');
  assert.equal((await transport.get('/api/v2/products')).cached, true);
  const status = await transport.resetSession();
  assert.equal(closed(), true);
  assert.equal(status.closed, false);
  assert.equal(status.resetting, false);
  assert.equal(status.cacheEntries, 0);
  assert.equal((await transport.get('/api/v2/products')).cached, false);
  assert.equal(calls.length, 2);
  await transport.close();
  await assert.rejects(transport.resetSession(), /closed/);
});

test('client rate limit enters cooldown and reset cannot bypass it', async () => {
  let requests = 0;
  let now = 100000;
  const transport = new CatalogTransport(
    {
      request: async () => {
        requests++;
        throw new KuperError('RATE_LIMITED', 'Client rate limited', 10000);
      },
      close: async () => {},
    },
    { now: () => now, intervalMs: 0 },
  );
  await assert.rejects(transport.get('/api/v2/products'), /rate limited/);
  assert.equal(transport.status().cooldownMs, 10000);
  assert.equal(transport.status().lastError?.code, 'RATE_LIMITED');
  assert.equal(transport.status().sessionBlocked, false);
  await transport.resetSession();
  await assert.rejects(transport.get('/api/v2/products'), /cooldown/);
  assert.equal(requests, 1);
  now += 10000;
  await assert.rejects(transport.get('/api/v2/products'), /rate limited/);
  assert.equal(requests, 2);
  await transport.close();
});

test('reset rejects pending work and blocks new requests until the session is released', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let releases = 0;
  const transport = new CatalogTransport(
    {
      request: async (path) => ({
        status: 200,
        contentType: 'application/json',
        body: '{}',
        retryAfter: null,
        url: 'https://kuper.ru' + path,
      }),
      close: async () => {
        releases++;
        await gate;
      },
    },
    { intervalMs: 0 },
  );
  const pending = transport.get('/api/v2/products');
  await assert.rejects(transport.resetSession(), /pending requests/);
  assert.equal(releases, 0);
  await pending;
  const reset = transport.resetSession();
  assert.equal(transport.status().resetting, true);
  await assert.rejects(transport.get('/api/v2/products'), /reset is in progress/);
  await assert.rejects(transport.resetSession(), /pending requests/);
  release();
  await reset;
  assert.equal(releases, 1);
  await transport.close();
});

test('different API requests preserve minimum interval', async () => {
  const { transport, calls, delays } = setup();
  await transport.get('/api/v2/products');
  await transport.get('/api/v2/stores');
  assert.deepEqual(calls, ['/api/v2/products', '/api/v2/stores']);
  assert.deepEqual(delays, [1500]);
  await transport.close();
});
