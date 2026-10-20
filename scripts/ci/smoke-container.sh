#!/usr/bin/env bash
# No live credentials, NAS mounts, SSH keys or collector are used here.
set -euo pipefail

app="${1:?usage: smoke-container.sh stripe-bridge|fleet-monitor}"
container="${app}-sanity"

case "$app" in
  stripe-bridge)
    port=8000
    ready=/version
    config=(
      -e STRIPE_API_KEY=sk_test_sanity
      -e STRIPE_WEBHOOK_SECRET=whsec_sanity
      -e WIZARR_BASE_URL=http://wizarr.invalid
      -e WIZARR_API_KEY=sanity
      -e PUBLIC_INVITE_BASE=http://invite.invalid
      -e SMTP_HOST=smtp.invalid
      -e SMTP_PORT=587
      -e SMTP_USER=sanity
      -e SMTP_PASS=sanity
      -e FROM_ADDR=sanity@invalid
      -e MAP_DB_PATH=/tmp/sanity.db
    )
    ;;
  fleet-monitor)
    port=8010
    ready=/health
    config=(
      -e 'FM_HOST_IPS=192.0.2.10,192.0.2.11,192.0.2.12,192.0.2.13,192.0.2.14'
      -e FM_SSH_USER=sanity
      -e FM_DB_PATH=/tmp/sanity.db
    )
    ;;
  *) echo "Unknown app: $app" >&2; exit 1 ;;
esac

cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    docker logs "$container" || true
  fi
  docker rm -f "$container" >/dev/null 2>&1 || true
  exit "$status"
}
trap cleanup EXIT

docker run -d --name "$container" -p "127.0.0.1:$port:$port" \
  "${config[@]}" "$app:sanity"

# Both the retry count and each request have a deadline: a wedged HTTP server
# must not consume the entire CI job timeout.
curl --fail --silent --show-error --retry 30 --retry-delay 1 \
  --retry-all-errors --retry-max-time 60 --connect-timeout 2 --max-time 3 \
  "http://127.0.0.1:$port$ready" >/dev/null

expect() {
  expected="$1"
  shift
  got="$(curl --silent --show-error --connect-timeout 2 --max-time 5 \
    -o /dev/null -w '%{http_code}' "$@")"
  if [ "$got" != "$expected" ]; then
    echo "::error::${*: -1} answered $got, expected $expected"
    return 1
  fi
  echo "✅ ${*: -1} -> $got"
}

base="http://127.0.0.1:$port"
if [ "$app" = stripe-bridge ]; then
  expect 200 "$base/version"
  expect 200 "$base/stripe/version"
  expect 401 "$base/admin/members"
  expect 400 -X POST -H 'Content-Type: application/json' -d '{}' "$base/webhook"
  expect 400 -X POST -H 'Content-Type: application/json' -d '{}' "$base/stripe/webhook"
  # The build leaves the test plumbing out of dist, so none of it ships.
  docker exec "$container" test ! -e dist/test
else
  expect 200 "$base/health"
  expect 401 "$base/fleet"
  expect 401 "$base/plays/overview"
  # The same image runs the collector, but importing its entrypoint would start
  # real probes. Check it is packaged without launching it.
  docker exec "$container" test -s dist/collectorMain.js
  docker exec "$container" ssh -V
fi
