import { KuperError } from '@kuper/core';
import type { Session, SessionOptions } from 'httpcloak';
import type { HttpReply, HttpSession } from './transport.ts';

export const HTTP_CATALOG_ORIGIN = 'https://kuper.ru';
// The generic alias selects the host OS. Kuper rejects the Linux variant with its
// VPN policy page, so keep the same reviewed client profile on every platform.
export const HTTP_CATALOG_PRESET = 'chrome-latest-windows';

type Client = Pick<Session, 'get' | 'close'>;
type Factory = (options: SessionOptions) => Promise<Client>;

export class HttpcloakSession implements HttpSession {
  private client: Promise<Client> | null = null;
  private readonly timeoutMs: number;
  private readonly factory: Factory;

  constructor(
    timeoutMs = 30000,
    factory: Factory = async (options) => {
      const { Session } = await import('httpcloak');
      return new Session(options);
    },
  ) {
    this.timeoutMs = timeoutMs;
    this.factory = factory;
  }

  async request(path: string): Promise<HttpReply> {
    // Относительный путь не должен позволять клиенту сменить хост.
    const url = new URL(path, HTTP_CATALOG_ORIGIN);
    if (!path.startsWith('/') || path.startsWith('//') || url.origin !== HTTP_CATALOG_ORIGIN) {
      throw new KuperError('INVALID_ROUTE', 'Only relative Kuper catalog paths are permitted');
    }

    try {
      this.client ??= this.factory({
        preset: HTTP_CATALOG_PRESET,
        timeout: this.timeoutMs / 1000,
        retry: 0,
        verify: true,
        allowRedirects: true,
        maxRedirects: 3,
      });
      const client = await this.client;
      const reply = await client.get(url.href, {
        headers: {
          Accept: 'application/json',
          'Accept-Language': 'ru-RU,ru;q=0.9',
          Origin: HTTP_CATALOG_ORIGIN,
          Referer: HTTP_CATALOG_ORIGIN + '/',
          'X-Requested-With': 'XMLHttpRequest',
        },
      });
      if (Buffer.byteLength(reply.text, 'utf8') > 2 * 1024 * 1024) {
        throw new KuperError('RESPONSE_TOO_LARGE', 'Catalog response exceeds 2 MiB');
      }
      // Нативная библиотека возвращает и строки, и массивы строк в заголовках.
      // Учитываем обе формы и регистр имён.
      const header = (name: string): string | null => {
        const value: unknown = Object.entries(reply.headers).find(
          ([key]) => key.toLowerCase() === name,
        )?.[1];
        return typeof value === 'string'
          ? value
          : Array.isArray(value) && typeof value[0] === 'string'
            ? value[0]
            : null;
      };
      return {
        status: reply.statusCode,
        contentType: header('content-type') ?? '',
        body: reply.text,
        retryAfter: header('retry-after'),
        url: reply.url,
      };
    } catch (error) {
      if (error instanceof KuperError) {
        throw error;
      }
      const message = error instanceof Error ? error.message : '';
      if (/timeout|timed out|deadline exceeded/i.test(message)) {
        throw new KuperError('NETWORK_TIMEOUT', 'Catalog request timed out');
      }
      // Текст нативной ошибки может содержать заголовки и URL: не отдаём его клиенту.
      throw new KuperError(
        'HTTP_CLIENT_ERROR',
        'HTTPcloak request failed; run node scripts/start.mjs to install dependencies',
      );
    }
  }

  async close() {
    const client = this.client;
    this.client = null;
    if (client) {
      const resolved = await client.catch(() => null);
      resolved?.close();
    }
  }
}
