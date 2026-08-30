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
COPY packages/security/package.json packages/security/package.json
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build \
  && cp -R apps/web/.next/static apps/web/.next/standalone/apps/web/.next/static

FROM node:24.16.0-bookworm-slim AS web

ARG SOURCE_COMMIT=local

ENV NODE_ENV=production
ENV HOSTNAME=0.0.0.0
ENV PORT=3000
ENV APP_BUILD_REVISION=$SOURCE_COMMIT

WORKDIR /app

COPY --from=build --chown=node:node /app/apps/web/.next/standalone ./
COPY --from=build --chown=node:node /app/dist/ops/bootstrap-owner.mjs ./bootstrap-owner.mjs

USER node
EXPOSE 3000
ENTRYPOINT ["node"]
CMD ["apps/web/server.js"]

FROM node:24.16.0-bookworm-slim AS worker

ARG SOURCE_COMMIT=local

ENV NODE_ENV=production
ENV APP_BUILD_REVISION=$SOURCE_COMMIT

WORKDIR /app

COPY --from=build --chown=node:node /app/apps/worker/dist/index.js ./worker.js
COPY --from=build --chown=node:node /app/node_modules/.pnpm/sharp@0.35.4_@types+node@24.13.3/node_modules/sharp ./node_modules/sharp
COPY --from=build --chown=node:node /app/node_modules/.pnpm/@img+colour@1.1.0/node_modules/@img/colour ./node_modules/@img/colour
COPY --from=build --chown=node:node /app/node_modules/.pnpm/detect-libc@2.1.2/node_modules/detect-libc ./node_modules/detect-libc
COPY --from=build --chown=node:node /app/node_modules/.pnpm/semver@7.8.5/node_modules/semver ./node_modules/semver
COPY --from=build --chown=node:node /app/node_modules/.pnpm/@img+sharp-linux-arm64@0.35.4/node_modules/@img/sharp-linux-arm64 ./node_modules/@img/sharp-linux-arm64
COPY --from=build --chown=node:node /app/node_modules/.pnpm/@img+sharp-libvips-linux-arm64@1.3.3/node_modules/@img/sharp-libvips-linux-arm64 ./node_modules/@img/sharp-libvips-linux-arm64

USER node
ENTRYPOINT ["node"]
CMD ["worker.js"]

FROM node:24.16.0-bookworm-slim AS migrate

ARG SOURCE_COMMIT=local

ENV NODE_ENV=production
ENV APP_BUILD_REVISION=$SOURCE_COMMIT

WORKDIR /app/packages/database/dist

COPY --from=build --chown=node:node /app/packages/database/dist/migrate.js ./migrate.js
COPY --from=build --chown=node:node /app/packages/database/migrations ../migrations

USER node
ENTRYPOINT ["node"]
CMD ["migrate.js"]
