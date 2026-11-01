# EnvDrop self-hosted server: same API and web page as the Cloudflare Worker,
# backed by an in-memory store (secrets never touch disk; a restart wipes them).
# syntax=docker/dockerfile:1

FROM node:22-alpine AS build
WORKDIR /src
COPY package.json package-lock.json ./
COPY shared/package.json shared/
COPY core/package.json core/
COPY server/package.json server/
COPY extension/package.json extension/
COPY cli/package.json cli/
RUN npm ci --ignore-scripts --no-audit --no-fund -w server -w shared --include-workspace-root
COPY tsconfig.base.json ./
COPY shared shared
COPY server server
RUN node node_modules/esbuild/install.js && npm run build:node -w server

FROM node:22-alpine
ENV NODE_ENV=production PORT=8787 HOST=0.0.0.0
WORKDIR /app
COPY --from=build /src/server/dist/node/server.mjs ./server.mjs
USER node
EXPOSE 8787
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
  CMD wget -qO- http://127.0.0.1:8787/health >/dev/null || exit 1
CMD ["node", "server.mjs"]
