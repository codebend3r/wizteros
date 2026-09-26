# Built from the repo root, not this directory: the app depends on
# libs/server-common through the bun workspace, so both have to be in the
# build context. Dockerfile.dockerignore next to this file allowlists exactly
# what the image needs, which keeps .env and the live data out of it.
#
# Bun installs and builds; Node runs, since that is the runtime NestJS
# supports. Bun is installed at the version the root package.json pins in
# `packageManager`, so the pin still lives in one place.

# One stage installs Bun, and both the build and the production install start
# from it, so a cold build fetches Bun once rather than once per stage.
FROM node:24-slim AS bun
WORKDIR /repo
COPY package.json bun.lock ./
RUN npm install --global "$(node -p "require('./package.json').packageManager")"
COPY libs/server-common/package.json libs/server-common/
COPY apps/fleet-monitor-nest/package.json apps/fleet-monitor-nest/

FROM bun AS build
RUN bun install --frozen-lockfile --ignore-scripts \
      --filter fleet-monitor-nest --filter @wizteros/server-common
COPY libs/server-common/ libs/server-common/
COPY apps/fleet-monitor-nest/ apps/fleet-monitor-nest/
RUN cd libs/server-common && bun run build \
 && cd ../../apps/fleet-monitor-nest && bun run build

FROM bun AS deps
RUN bun install --frozen-lockfile --ignore-scripts --production --filter fleet-monitor-nest

FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /repo
COPY --from=deps /repo ./
COPY --from=build /repo/libs/server-common/dist libs/server-common/dist
COPY --from=build /repo/apps/fleet-monitor-nest/dist apps/fleet-monitor-nest/dist
WORKDIR /repo/apps/fleet-monitor-nest
EXPOSE 8010
CMD ["node", "dist/main.js"]
