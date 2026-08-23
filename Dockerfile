# syntax=docker/dockerfile:1.7

FROM node:24.16.0-bookworm-slim AS build

ENV PNPM_HOME=/pnpm
ENV PATH=$PNPM_HOME:$PATH

WORKDIR /app

RUN corepack enable && corepack prepare pnpm@11.22.0 --activate

COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/web/package.json apps/web/package.json
COPY apps/worker/package.json apps/worker/package.json
COPY packages/config/package.json packages/config/package.json
COPY packages/database/package.json packages/database/package.json
COPY packages/identity/package.json packages/identity/package.json
COPY packages/observability/package.json packages/observability/package.json
COPY packages/queue/package.json packages/queue/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build \
  && cp -R apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static

FROM node:24.16.0-bookworm-slim AS web

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000

WORKDIR /app

COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./

USER node
EXPOSE 3000
ENTRYPOINT ["node"]
CMD ["apps/web/server.js"]

FROM node:24.16.0-bookworm-slim AS worker

ENV NODE_ENV=production

WORKDIR /app

COPY --from=build --chown=node:node /app/apps/worker/dist/index.js ./worker.js

USER node
ENTRYPOINT ["node"]
CMD ["worker.js"]

FROM node:24.16.0-bookworm-slim AS migrate

ENV NODE_ENV=production

WORKDIR /app/packages/database/dist

COPY --from=build --chown=node:node /app/packages/database/dist/migrate.js ./migrate.js
COPY --from=build --chown=node:node /app/packages/database/migrations ../migrations

USER node
ENTRYPOINT ["node"]
CMD ["migrate.js"]
