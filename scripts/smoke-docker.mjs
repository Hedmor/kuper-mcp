import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// SDK берём из workspace приложения, без дублирования корневых зависимостей.
const require = createRequire(new URL('../apps/mcp/package.json', import.meta.url));
const { Client } = await import(
  pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href
);
const { StdioClientTransport } = await import(
  pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href
);
const client = new Client({ name: 'docker-smoke', version: '1.0.0' });
const transport = new StdioClientTransport({
  command: 'docker',
  args: ['run', '--rm', '--init', '-i', process.argv[2] ?? 'kuper-mcp:local'],
  cwd: fileURLToPath(new URL('../', import.meta.url)),
  stderr: 'inherit',
});
// Ограничиваем проверку по времени и всегда закрываем клиент вместе с контейнером.
const timer = setTimeout(() => {
  console.error('Docker MCP smoke: timeout');
  void client.close().finally(() => process.exit(1));
}, 30000);
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 13);
  const status = await client.callTool({ name: 'kuper_session_status', arguments: {} });
  assert.equal(status.structuredContent.data.origin, 'https://kuper.ru');
  const recipes = await client.readResource({ uri: 'kuper://recipes' });
  assert.equal(JSON.parse(recipes.contents[0].text).recipes.length, 15);
  console.error('Docker MCP smoke: PASS (initialize, tools, status, recipes)');
} finally {
  clearTimeout(timer);
  await client.close();
}
