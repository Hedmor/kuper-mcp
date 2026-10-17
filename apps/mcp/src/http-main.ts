import { createHttpMcp } from './http.ts';

const port = Number(process.env.KUPER_HTTP_PORT ?? '8815');
const host = process.env.KUPER_HTTP_HOST ?? '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('Invalid HTTP port');
}
const app = createHttpMcp();
let stopping = false;
async function shutdown() {
  if (stopping) {
    return;
  }
  stopping = true;
  const timer = setTimeout(() => process.exit(1), 10000);
  timer.unref();
  try {
    await app.close();
  } finally {
    clearTimeout(timer);
  }
}
process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());
app.http.once('error', () => {
  console.error('kuper-mcp HTTP listener failed');
  process.exitCode = 1;
  void shutdown();
});
app.http.listen(port, host, () => console.error(`kuper-mcp ready (HTTP, port ${port})`));
