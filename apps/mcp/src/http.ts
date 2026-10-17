import { createServer as createHttpServer } from 'node:http';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createCatalog, type KuperCatalog } from '@kuper/scraper';
import { createServer } from './server.ts';

// Each HTTP request gets an MCP transport; all clients share the catalog queue and cache.
export function createHttpMcp(catalog: KuperCatalog = createCatalog()) {
  const active = new Set<ReturnType<typeof createServer>['server']>();
  const http = createHttpServer(async (request, response) => {
    const host = request.headers.host ?? '';
    if (!/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host)) {
      response.writeHead(403).end();
      return;
    }
    if (
      request.headers.origin &&
      !['http://' + host, 'https://' + host].includes(request.headers.origin)
    ) {
      response.writeHead(403).end();
      return;
    }
    if (request.url === '/health' && request.method === 'GET') {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"ready":true}');
      return;
    }
    if (request.url !== '/mcp') {
      response.writeHead(404).end();
      return;
    }
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' }).end();
      return;
    }
    if (active.size >= 16) {
      response.writeHead(503).end();
      return;
    }
    const { server } = createServer(catalog);
    active.add(server);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    try {
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += Buffer.byteLength(chunk);
        if (bytes > 1024 * 1024) {
          response.writeHead(413).end();
          return;
        }
        chunks.push(Buffer.from(chunk));
      }
      let body: unknown;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        response.writeHead(400).end();
        return;
      }
      await server.connect(transport);
      await transport.handleRequest(request, response, body);
    } catch {
      if (!response.headersSent) {
        response.writeHead(500);
      }
      response.end();
    } finally {
      active.delete(server);
      await server.close();
    }
  });
  http.requestTimeout = 30000;
  http.headersTimeout = 10000;
  return {
    http,
    async close() {
      const closed = new Promise<void>((resolve, reject) => {
        http.close((error) => (error ? reject(error) : resolve()));
      });
      http.closeIdleConnections();
      await Promise.all([...active].map((server) => server.close()));
      await closed;
      await catalog.close();
    },
  };
}
