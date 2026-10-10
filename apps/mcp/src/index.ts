import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createServer } from './server.ts';

const { server, catalog } = createServer();

let stopping = false;

async function shutdown() {
  if (stopping) {
    return;
  }

  stopping = true;

  const timer = setTimeout(() => process.exit(1), 10000);

  timer.unref();

  try {
    await catalog.close();
    await server.close();
    clearTimeout(timer);
  } catch {
    process.exitCode = 1;
  }
}

process.once('SIGINT', () => void shutdown());

process.once('SIGTERM', () => void shutdown());

process.stdin.once('end', () => void shutdown());

try {
  await server.connect(new StdioServerTransport());
  console.error('kuper-mcp ready (stdio)');
} catch {
  console.error('kuper-mcp startup failed');
  await shutdown();
  process.exitCode = 1;
}
