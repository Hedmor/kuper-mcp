import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { createServer } from '../src/server.ts';
import { KuperCatalog, CatalogTransport } from '@kuper/scraper';
import type { HttpSession } from '../../../packages/scraper/src/transport.ts';

test('MCP initializes, lists 13 tools, validates input and serves resource/prompt', async () => {
  const session: HttpSession = {
    request: async () => {
      throw new Error('Unexpected live request');
    },
    close: async () => {},
  };
  const { server, catalog } = createServer(new KuperCatalog(new CatalogTransport(session)));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'test', version: '1.0.0' });

  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);

    const { tools } = await client.listTools();

    assert.equal(tools.length, 13);
    assert.ok(
      tools
        .filter((t) => t.name !== 'kuper_session_reset')
        .every((t) => t.annotations?.readOnlyHint),
    );
    assert.equal(
      tools.find((t) => t.name === 'kuper_session_reset')?.annotations?.readOnlyHint,
      false,
    );

    const status = await client.callTool({ name: 'kuper_session_status', arguments: {} });

    assert.ok(!status.isError);

    const reset = await client.callTool({ name: 'kuper_session_reset', arguments: {} });
    assert.ok(!reset.isError);
    assert.equal(
      (reset.structuredContent as { data: { resetting: boolean } }).data.resetting,
      false,
    );

    const invalid = await client.callTool({
      name: 'kuper_list_stores',
      arguments: { latitude: 999, longitude: 82 },
    });

    assert.equal(invalid.isError, true);

    const recipes = await client.readResource({ uri: 'kuper://recipes' });

    assert.equal(recipes.contents.length, 1);

    const prompt = await client.getPrompt({
      name: 'plan_weekly_menu',
      arguments: { request: 'Меню на неделю' },
    });

    assert.equal(prompt.messages.length, 1);

    const plan = await client.callTool({
      name: 'kuper_plan_week',
      arguments: { offers: [], options: { budgetRub: 1000, dailyKcal: 2000, days: 1 } },
    });

    assert.ok(!plan.isError);

    const data = plan.structuredContent as { data: { status: string; constraintsMet: boolean } };

    assert.equal(data.data.status, 'insufficient_data');
    assert.equal(data.data.constraintsMet, false);
  } finally {
    await client.close();
    await server.close();
    await catalog.close();
  }
});

test('launcher builds and starts stdio MCP with installed dependencies from another working directory', async () => {
  const client = new Client({ name: 'stdio-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../../../scripts/start.mjs', import.meta.url)), '--no-install'],
    cwd: tmpdir(),
    stderr: 'pipe',
  });

  try {
    await client.connect(transport);
    assert.equal((await client.listTools()).tools.length, 13);
    const status = await client.callTool({ name: 'kuper_session_status', arguments: {} });
    assert.equal(
      (status.structuredContent as { data: { origin: string } }).data.origin,
      'https://kuper.ru',
    );
  } finally {
    await client.close();
  }
});
