# The one image recipe for both NestJS servers. Build args pick the app:
#
#   stripe-bridge   --build-arg APP=stripe-bridge --build-arg PORT=8000
#                   --build-arg DB_ENV=MAP_DB_PATH --build-arg DB_FILE=bridge.db
#   fleet-monitor   --build-arg APP=fleet-monitor --build-arg PORT=8010
#                   --build-arg DB_ENV=FM_DB_PATH --build-arg DB_FILE=fleet.db
#                   --build-arg SYSTEM_PACKAGES=openssh-client
#
# docker-compose.yml, each app's `docker-build` target and CI pass exactly
# these. Every app starts from `node dist/main.js`; the fleet collector is the
# fleet-monitor image with `node dist/collectorMain.js` as its compose command.
#
# Built from the repo root, not an app directory: each app depends on
# libs/server-common and libs/wire through the bun workspace, so all three
# have to be in the build context. server.Dockerfile.dockerignore next to this
# file allowlists exactly what an image may take, which keeps .env and the
# live data out of it.
#
# Bun installs and builds; Node runs, since that is the runtime NestJS
# supports. Bun is installed at the version the root package.json pins in
# `packageManager`, so the pin still lives in one place.

# One stage installs Bun, and both the build and the production install start
# from it, so a cold build fetches Bun once rather than once per stage.
FROM node:24-slim AS bun
ARG APP
RUN test -n "$APP" || { echo 'build with --build-arg APP=<app>' >&2; exit 1; }
WORKDIR /repo
COPY package.json bun.lock ./
RUN npm install --global "$(node -p "require('./package.json').packageManager")"
COPY libs/server-common/package.json libs/server-common/
COPY libs/wire/package.json libs/wire/
COPY apps/${APP}/package.json apps/${APP}/

FROM bun AS build
ARG APP
RUN bun install --frozen-lockfile --ignore-scripts \
      --filter "$APP" --filter @wizteros/server-common --filter @wizteros/wire
COPY tsconfig.server.json ./
COPY libs/server-common/ libs/server-common/
COPY libs/wire/ libs/wire/
COPY apps/${APP}/ apps/${APP}/
RUN cd libs/server-common && bun run build \
 && cd ../wire && bun run build \
 && cd "../../apps/$APP" && bun run build

FROM bun AS deps
ARG APP
RUN bun install --frozen-lockfile --ignore-scripts --production --filter "$APP"

FROM node:24-slim
ARG APP
ARG PORT
ARG DB_ENV
ARG DB_FILE
# What the app needs from the OS beyond Node. The fleet collector reaches all
# five hosts with the system ssh binary, the same way the Python collector
# did, and runs from the fleet-monitor image; the bridge needs nothing.
ARG SYSTEM_PACKAGES=""
RUN if [ -n "$SYSTEM_PACKAGES" ]; then \
      apt-get update \
   && apt-get install -y --no-install-recommends $SYSTEM_PACKAGES \
   && rm -rf /var/lib/apt/lists/*; \
    fi
ENV NODE_ENV=production
# The app's SQLite file. compose bind-mounts the app's data directory here:
# for the bridge the customer map, tags, links and event log the Python bridge
# wrote, for the monitor the fleet history.
ENV ${DB_ENV}=/data/${DB_FILE}
VOLUME ["/data"]
WORKDIR /repo
COPY --from=deps /repo ./
COPY --from=build /repo/libs/server-common/dist libs/server-common/dist
COPY --from=build /repo/libs/wire/dist libs/wire/dist
COPY --from=build /repo/apps/${APP}/dist apps/${APP}/dist
WORKDIR /repo/apps/${APP}
EXPOSE ${PORT}
CMD ["node", "dist/main.js"]
