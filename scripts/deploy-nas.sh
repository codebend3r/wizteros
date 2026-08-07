#!/usr/bin/env bash
# Push code changes (compose, bridge, docs) from this repo to the Synology NAS
# over a mounted SMB share. Safe to run repeatedly.
#
# Deliberately EXCLUDED so we never clobber live NAS state:
#   .env                 - the NAS has its own (PUID/PGID, service-name URLs, TUNNEL_TOKEN)
#   wizarr-data/         - live Wizarr DB lives on the NAS after migration
#   tautulli-config/     - live Tautulli state
#   stripe-bridge-data/  - the bridge's SQLite mapping
#
# Prereq: mount the share first — Finder > Cmd+K > smb://192.168.50.2 > "docker".
# Override the destination with:  NAS_MOUNT=/Volumes/docker/stripe-bridge npm run deploy:nas
set -euo pipefail

DEST="${NAS_MOUNT:-/Volumes/docker/stripe-bridge}"
MOUNT_ROOT="$(dirname "$DEST")"

if [ ! -d "$MOUNT_ROOT" ]; then
  echo "✗ $MOUNT_ROOT is not mounted."
  echo "  In Finder press Cmd+K, connect to smb://192.168.50.2, and mount the 'docker' share."
  exit 1
fi

echo "→ Deploying code to $DEST"
rsync -av \
  --exclude '.git' \
  --exclude 'venv' \
  --exclude 'node_modules' \
  --exclude '.nx' \
  --exclude 'dist' \
  --exclude '.netlify' \
  --exclude '.env' \
  --exclude 'wizarr-data' \
  --exclude 'tautulli-config' \
  --exclude 'stripe-bridge-data' \
  "$(cd "$(dirname "$0")/.." && pwd)/" \
  "$DEST/"

echo "✓ Code synced. On the NAS, apply it with:"
echo "    cd /volume1/docker/stripe-bridge && sudo docker compose up -d --build"
