# Built from the repo root, not this directory: the app depends on
# libs/server-common through the bun workspace, so both have to be in the
# build context. Dockerfile.dockerignore next to this file allowlists exactly
# what the image needs, which keeps .env and the live data out of it.
#
# Bun installs and builds; Node runs, since that is the runtime NestJS
# supports. Bun is installed at the version the root package.json pins in
# `packageManager`, so the pin still lives in one place.

FROM node:24-slim AS build
WORKDIR /repo
COPY package.json bun.lock ./
RUN npm install --global "$(node -p "require('./package.json').packageManager")"
COPY libs/server-common/package.json libs/server-common/
COPY apps/stripe-bridge-nest/package.json apps/stripe-bridge-nest/
RUN bun install --frozen-lockfile --ignore-scripts \
      --filter stripe-bridge-nest --filter @wizteros/server-common
COPY libs/server-common/ libs/server-common/
COPY apps/stripe-bridge-nest/ apps/stripe-bridge-nest/
RUN cd libs/server-common && bun run build \
 && cd ../../apps/stripe-bridge-nest && bun run build

FROM node:24-slim AS deps
WORKDIR /repo
COPY package.json bun.lock ./
RUN npm install --global "$(node -p "require('./package.json').packageManager")"
COPY libs/server-common/package.json libs/server-common/
COPY apps/stripe-bridge-nest/package.json apps/stripe-bridge-nest/
RUN bun install --frozen-lockfile --ignore-scripts --production --filter stripe-bridge-nest

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=deps /repo ./
COPY --from=build /repo/libs/server-common/dist libs/server-common/dist
COPY --from=build /repo/apps/stripe-bridge-nest/dist apps/stripe-bridge-nest/dist
WORKDIR /repo/apps/stripe-bridge-nest
EXPOSE 8000
CMD ["node", "dist/main.js"]
