import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Загружаем .env из проекта даже при запуске из другого каталога.
// stdout оставляем исключительно для MCP JSON-RPC.
const root = fileURLToPath(new URL('../', import.meta.url));
process.chdir(root);
if (existsSync('.env')) process.loadEnvFile('.env');

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: root,
    stdio: ['ignore', process.stderr, process.stderr],
    windowsHide: true,
    env: {
      ...process.env,
      npm_config_cache: process.env.npm_config_cache ?? root + '.local/npm-cache',
    },
  });
  if (result.error || result.status !== 0) {
    console.error('[kuper-mcp] Setup failed:', result.error?.message ?? result.status);
    process.exit(1);
  }
}

// --no-install подходит для уже установленного проекта и офлайн-проверок.
if (!process.argv.includes('--no-install')) {
  console.error('[kuper-mcp] Preparing dependencies and build…');
  // npm входит в Node.js; закреплённый pnpm не требует глобальной установки.
  // Команды оболочки ниже — константы, пользовательский ввод в них не подставляется.
  if (process.platform === 'win32') {
    run(process.env.ComSpec ?? 'cmd.exe', [
      '/d',
      '/s',
      '/c',
      'npm.cmd exec --yes --package=pnpm@12.10.1 -- pnpm install --frozen-lockfile --prod=false',
    ]);
  } else {
    run('npm', [
      'exec',
      '--yes',
      '--package=pnpm@12.10.1',
      '--',
      'pnpm',
      'install',
      '--frozen-lockfile',
      '--prod=false',
    ]);
  }
}
run(process.execPath, ['node_modules/typescript/bin/tsc', '-b']);
await import('../apps/mcp/dist/index.js');
