import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const require = createRequire(new URL('../apps/mcp/package.json', import.meta.url));
const { Client } = await import(
  pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href
);
const { StreamableHTTPClientTransport } = await import(
  pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/streamableHttp.js')).href
);
const url = new URL(process.argv[2] ?? 'http://127.0.0.1:8815/mcp');
const clients = [
  new Client({ name: 'http-smoke-a', version: '1' }),
  new Client({ name: 'http-smoke-b', version: '1' }),
];
try {
  for (const client of clients) {
    await client.connect(new StreamableHTTPClientTransport(url));
    assert.equal((await client.listTools()).tools.length, 13);
    const status = await client.callTool({ name: 'kuper_session_status', arguments: {} });
    assert.ok(!status.isError);
    const recipes = await client.readResource({ uri: 'kuper://recipes' });
    assert.equal(JSON.parse(recipes.contents[0].text).recipes.length, 15);
  }
  console.log('HTTP MCP smoke: PASS (two clients, tools, status, recipes)');
  if (process.env.KUPER_SMOKE_STORE_ID) {
    const result = await clients[0].callTool({
      name: 'kuper_search_products',
      arguments: {
        storeId: process.env.KUPER_SMOKE_STORE_ID,
        query: process.env.KUPER_SMOKE_QUERY ?? '\u043a\u0443\u0440\u0438\u0446\u0430',
      },
    });
    if (result.isError) {
      console.log(JSON.stringify(result.content));
      process.exitCode = 1;
    } else {
      console.log(JSON.stringify({ products: result.structuredContent.data.products.length }));
    }
  }
} finally {
  await Promise.all(clients.map((client) => client.close()));
}
