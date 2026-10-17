import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const source = resolve('packages/scraper/src/httpcloak.ts');
const modulePath = existsSync(source) ? source : resolve('packages/scraper/dist/httpcloak.js');
const { HttpcloakSession, HTTP_CATALOG_PRESET } = await import(pathToFileURL(modulePath).href);

// Print response metadata only; never cookies, headers or complete response bodies.
const session = new HttpcloakSession();
console.log(
  JSON.stringify({
    platform: process.platform,
    node: process.version,
    preset: HTTP_CATALOG_PRESET,
  }),
);
try {
  const paths = ['/api/v2/app_configuration'];
  if (process.env.KUPER_SMOKE_LAT && process.env.KUPER_SMOKE_LON) {
    const params = new URLSearchParams({
      lat: process.env.KUPER_SMOKE_LAT,
      lon: process.env.KUPER_SMOKE_LON,
      per_page: '24',
      shipping_method: 'delivery',
    });
    paths.push('/api/v2/stores?' + params);
  }
  if (process.env.KUPER_SMOKE_STORE_ID) {
    const params = new URLSearchParams({
      page: '1',
      per_page: '24',
      q: process.env.KUPER_SMOKE_QUERY ?? '\u043a\u0443\u0440\u0438\u0446\u0430',
      sid: process.env.KUPER_SMOKE_STORE_ID,
      sort: 'popularity',
    });
    paths.push('/api/v2/products?' + params);
  }
  for (const path of paths) {
    const reply = await session.request(path);
    let shape = null;
    try {
      const body = JSON.parse(reply.body);
      shape = {
        keys: Object.keys(body),
        configKeys: body.app_configuration ? Object.keys(body.app_configuration) : undefined,
        count: body.products?.length,
      };
    } catch {
      shape = {
        vpnPolicyPage:
          /vpn/i.test(reply.body) &&
          /\u043e\u0442\u043a\u043b\u044e\u0447\u0438\u0442\u0435/i.test(reply.body),
      };
    }
    console.log(
      JSON.stringify({
        path: path.split('?')[0],
        status: reply.status,
        contentType: reply.contentType,
        finalPath: new URL(reply.url).pathname,
        bytes: Buffer.byteLength(reply.body),
        shape,
      }),
    );
    if (reply.status !== 200 || !reply.contentType.includes('json')) process.exitCode = 1;
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
} finally {
  await session.close();
}
