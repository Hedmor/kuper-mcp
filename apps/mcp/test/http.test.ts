import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { CatalogTransport, KuperCatalog } from '@kuper/scraper';
import { createHttpMcp } from '../src/http.ts';

test('multiple HTTP clients share one catalog and listener; reject foreign browser origins and hosts', async () => {
  let requests = 0;
  const catalog = new KuperCatalog(
    new CatalogTransport(
      {
        async request(path) {
          requests++;
          return {
            status: 200,
            contentType: 'application/json',
            body: '{"products":[]}',
            retryAfter: null,
            url: 'https://kuper.ru' + path,
          };
        },
        async close() {},
      },
      { intervalMs: 0 },
    ),
  );
  const app = createHttpMcp(catalog);
  app.http.listen(0, '127.0.0.1');
  await once(app.http, 'listening');
  const address = app.http.address();
  assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const clients = [
    new Client({ name: 'first', version: '1' }),
    new Client({ name: 'second', version: '1' }),
  ];
  try {
    for (const client of clients) {
      await client.connect(new StreamableHTTPClientTransport(new URL(base + '/mcp')));
      assert.equal((await client.listTools()).tools.length, 13);
      const result = await client.callTool({
        name: 'kuper_search_products',
        arguments: { storeId: '121', query: 'milk' },
      });
      assert.ok(!result.isError);
    }
    assert.equal(requests, 1, 'both clients use the same cache');
    assert.equal((await fetch(base + '/health')).status, 200);
    assert.equal(
      (await fetch(base + '/mcp', { method: 'POST', headers: { Origin: 'https://example.com' } }))
        .status,
      403,
    );
    const foreignHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(
        base + '/mcp',
        { method: 'POST', headers: { Host: 'example.com' } },
        (response) => {
          response.resume();
          resolve(response.statusCode);
        },
      );
      request.on('error', reject);
      request.end();
    });
    assert.equal(foreignHostStatus, 403);
    assert.equal((await fetch(base + '/mcp', { method: 'POST', body: 'invalid' })).status, 400);
    assert.equal((await fetch(base + '/mcp')).status, 405);
  } finally {
    await Promise.all(clients.map((client) => client.close()));
    await app.close();
  }
});
