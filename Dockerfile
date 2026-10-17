# syntax=docker/dockerfile:1
# Debian/glibc совместим с нативной библиотекой HTTPcloak; браузера в образе нет.
FROM node:22-bookworm-slim AS base
WORKDIR /app
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

FROM base AS dependencies
RUN npm install --global pnpm@12.10.1
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml .npmrc ./
COPY apps/mcp/package.json ./apps/mcp/package.json
COPY packages/core/package.json ./packages/core/package.json
COPY packages/planner/package.json ./packages/planner/package.json
COPY packages/scraper/package.json ./packages/scraper/package.json
RUN pnpm install --frozen-lockfile --prod
# Загрузка нативной библиотеки проверяется при сборке, без запросов к Куперу.
RUN cd packages/scraper && node --input-type=module -e "import { Session } from 'httpcloak'; const s = new Session({ preset: 'chrome-latest-windows' }); s.close();"

FROM dependencies AS build
RUN pnpm install --frozen-lockfile --prod=false
COPY tsconfig.json tsconfig.base.json ./
COPY apps/mcp ./apps/mcp
COPY packages ./packages
RUN pnpm run build

FROM base AS runtime
ENV NODE_ENV=production
# Только production-зависимости, манифесты и результат сборки.
COPY --from=dependencies /app/node_modules ./node_modules
COPY --from=dependencies /app/apps ./apps
COPY --from=dependencies /app/packages ./packages
COPY --from=build /app/apps/mcp/dist ./apps/mcp/dist
COPY --from=build /app/packages/core/dist ./packages/core/dist
COPY --from=build /app/packages/planner/dist ./packages/planner/dist
COPY --from=build /app/packages/scraper/dist ./packages/scraper/dist
USER node
# stdio принадлежит MCP-клиенту: запускайте с -i, без TTY.
ENTRYPOINT ["node", "apps/mcp/dist/index.js"]
