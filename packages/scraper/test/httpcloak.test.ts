import test from 'node:test';
import assert from 'node:assert/strict';
import type { Response, SessionOptions } from 'httpcloak';
import { HttpcloakSession } from '../src/httpcloak.ts';
import { CatalogTransport } from '../src/transport.ts';

function setup(overrides: Partial<Response> = {}) {
  const calls: string[] = [];
  const options: SessionOptions[] = [];
  let closed = 0;
  const session = new HttpcloakSession(1500, async (config) => {
    options.push(config);
    return {
      get: async (url) => {
        calls.push(url);
        return {
          statusCode: 200,
          url,
          text: '{"products":[]}',
          // Reproduce the native runtime shape, which differs from its typings.
          headers: { 'Content-Type': ['application/json'] },
          ...overrides,
        } as unknown as Response;
      },
      close: () => {
        closed++;
      },
    };
  });
  return { session, calls, options, closed: () => closed };
}

test('HTTPcloak uses one session, seconds timeout, array headers and resets cleanly', async () => {
  const s = setup();
  const reply = await s.session.request('/api/v2/products?q=milk');
  assert.equal(reply.contentType, 'application/json');
  await s.session.request('/api/v2/stores');
  assert.equal(s.options.length, 1);
  assert.equal(s.options[0]!.preset, 'chrome-latest-windows');
  assert.equal(s.options[0]!.timeout, 1.5);
  assert.equal(s.options[0]!.retry, 0);
  assert.equal(s.options[0]!.verify, true);
  assert.equal(s.calls[0], 'https://kuper.ru/api/v2/products?q=milk');
  await s.session.close();
  await s.session.close();
  assert.equal(s.closed(), 1);
  await s.session.request('/api/v2/stores');
  assert.equal(s.options.length, 2);
  await s.session.close();
});

test('HTTPcloak rejects external URLs before contacting native client and bounds responses', async () => {
  const s = setup({ text: 'a'.repeat(2 * 1024 * 1024 + 1) });
  for (const path of ['https://example.com', '//example.com', '/\\example.com']) {
    await assert.rejects(s.session.request(path), { code: 'INVALID_ROUTE' });
  }
  assert.equal(s.calls.length, 0);
  await assert.rejects(s.session.request('/api/v2/products'), { code: 'RESPONSE_TOO_LARGE' });
  await s.session.close();
});

test('HTTPcloak direct API respects catalog allowlist, caching, redirects and 429 cooldown', async () => {
  const s = setup({ statusCode: 429, headers: { 'retry-after': '7' } });
  const transport = new CatalogTransport(s.session, {
    origin: 'https://kuper.ru',
    intervalMs: 0,
  });
  await assert.rejects(transport.get('/anything'), { code: 'INVALID_ROUTE' });
  await assert.rejects(transport.get('/api/v2/products'), {
    code: 'RATE_LIMITED',
    retryAfterMs: 7000,
  });
  await assert.rejects(transport.get('/api/v2/stores'), { code: 'RATE_LIMITED' });
  assert.equal(s.calls.length, 1);
  await transport.close();

  const redirected = setup({ url: 'https://example.com/api/v2/products' });
  const other = new CatalogTransport(redirected.session, {
    origin: 'https://kuper.ru',
    intervalMs: 0,
  });
  await assert.rejects(other.get('/api/v2/products'), { code: 'SESSION_REQUIRED' });
  await other.close();
});

test('HTTPcloak reports safe failures and can reopen after failed initialization', async () => {
  let attempts = 0;
  const session = new HttpcloakSession(1000, async () => {
    attempts++;
    throw new Error('private-url?cookie=secret');
  });
  await assert.rejects(session.request('/api/v2/stores'), { code: 'HTTP_CLIENT_ERROR' });
  await session.close();
  await assert.rejects(session.request('/api/v2/stores'), { code: 'HTTP_CLIENT_ERROR' });
  assert.equal(attempts, 2);
  await session.close();
});
