#!/usr/bin/env bash
# Deploy the wizteros repo to the Synology NAS and rebuild the stripe-bridge
# container, with preflight gating, health verification and image rollback.
#
# Deliberately NEVER touched on the NAS (live state, not code):
#   .env                 - the NAS has its own (PUID/PGID, host-port URLs, TUNNEL_TOKEN)
#   wizarr-data/         - live Wizarr DB, incl. the healed library-name cache
#   tautulli-config/     - live Tautulli state
#   stripe-bridge-data/  - the bridge's SQLite mapping (bridge.db)
#
# The westeroz compose project (wizarr/tautulli/sab/radarr/sonarr) is a separate
# stack on the NAS and is never rebuilt here.
set -euo pipefail

# This script lives at <repo>/.claude/skills/deploy-nas/scripts/, so the repo
# root is four levels up — no hardcoded path, works from any clone or worktree.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${WZ_REPO:-$(cd "$SCRIPT_DIR/../../../.." && pwd)}"
NAS_HOST="${WZ_NAS_HOST:-crivas@192.168.50.2}"
NAS_PATH="${WZ_NAS_PATH:-/volume1/docker/stripe-bridge}"
SMB_PATH="${WZ_SMB_PATH:-/Volumes/docker/stripe-bridge}"
DOCKER="/usr/local/bin/docker"   # NOPASSWD sudoers rule matches this literal path
SERVICE="stripe-bridge"
SHA_FILE=".deployed-sha"
SSH="ssh -o BatchMode=yes -o ConnectTimeout=10"

DRY_RUN=0; FORCE=0; ROLLBACK=1; SKIP_VERIFY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)     DRY_RUN=1 ;;
    --force)       FORCE=1 ;;
    --no-rollback) ROLLBACK=0 ;;
    --skip-verify) SKIP_VERIFY=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
step() { printf '\n▸ %s\n' "$*"; }
die()  { printf '\n✗ %s\n' "$*" >&2; exit 1; }

# Everything the NAS container is actually built from. A main that only moved
# web/ or docs/ needs no rebuild — Netlify owns the SPA.
NAS_PATHS=(stripe-bridge docker-compose.yml scripts package.json)

say "═══════════════════════════════════════════"
say "deploy-nas — wizteros stripe-bridge"
say "═══════════════════════════════════════════"
say "repo:  $REPO"
say "nas:   $NAS_HOST:$NAS_PATH"
[ "$DRY_RUN" = 1 ] && say "mode:  DRY RUN (nothing will change)"

cd "$REPO" || die "repo not found: $REPO"

# ─── preflight ────────────────────────────────────────────────────────────────
step "Preflight"

git rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "not a git repo: $REPO"

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
[ "$BRANCH" = "main" ] || die "on '$BRANCH', not main. Deploy ships main only — switch first."

if [ -n "$(git status --porcelain)" ]; then
  git status --short | sed 's/^/    /'
  die "working tree is dirty. Commit or stash before deploying — the NAS gets your working tree, not your last commit."
fi

git fetch --quiet origin main || die "could not fetch origin"
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse origin/main)"
if [ "$LOCAL" != "$REMOTE" ]; then
  AHEAD="$(git rev-list --count origin/main..HEAD)"
  BEHIND="$(git rev-list --count HEAD..origin/main)"
  die "main is out of sync with origin (ahead $AHEAD, behind $BEHIND). Sync first — never ship a SHA that isn't on origin."
fi
say "  · on main, clean, in sync with origin ($(git rev-parse --short HEAD))"

$SSH "$NAS_HOST" true 2>/dev/null || die "cannot reach $NAS_HOST over SSH (key auth). Is the NAS up / are you on the LAN?"
say "  · NAS reachable over SSH"

# ─── what is already deployed ─────────────────────────────────────────────────
step "Comparing local HEAD against what the NAS is running"

DEPLOYED="$($SSH "$NAS_HOST" "cat $NAS_PATH/$SHA_FILE 2>/dev/null || true" | tr -d '[:space:]')"

if [ -z "$DEPLOYED" ]; then
  say "  · NAS has no deploy marker yet (first run of this skill) — treating as stale"
elif [ "$DEPLOYED" = "$LOCAL" ]; then
  if [ "$FORCE" = 0 ]; then
    say "  · NAS is already on $(git rev-parse --short HEAD) — nothing to do."
    say ""
    say "✓ Already current. Use --force to rebuild anyway."
    exit 0
  fi
  say "  · NAS already on this SHA, but --force given"
else
  if git cat-file -e "$DEPLOYED^{commit}" 2>/dev/null; then
    COUNT="$(git rev-list --count "$DEPLOYED..$LOCAL" 2>/dev/null || echo '?')"
    say "  · NAS is $COUNT commit(s) behind (deployed ${DEPLOYED:0:7}, local $(git rev-parse --short HEAD))"
    CHANGED="$(git diff --name-only "$DEPLOYED" "$LOCAL" -- "${NAS_PATHS[@]}" 2>/dev/null || true)"
    if [ -z "$CHANGED" ]; then
      say "  · none of those commits touch NAS-built paths (stripe-bridge/, compose, scripts)"
      if [ "$FORCE" = 0 ]; then
        say ""
        say "✓ Nothing the NAS builds from has changed — skipping rebuild."
        say "  (web/ ships via Netlify.) Use --force to rebuild anyway."
        exit 0
      fi
    else
      say "  · NAS-built paths changed:"
      printf '%s\n' "$CHANGED" | sed 's/^/      /'
    fi
  else
    say "  · deployed SHA ${DEPLOYED:0:7} is unknown to this clone — treating as stale"
  fi
fi

if [ "$DRY_RUN" = 1 ]; then
  step "Dry run — would sync and rebuild"
  if [ -d "$SMB_PATH" ]; then
    say "  transport: rsync over SMB mount ($SMB_PATH)"
  else
    say "  transport: tar over SSH (SMB not mounted)"
  fi
  say "  then: cd $NAS_PATH && sudo -n $DOCKER compose up -d --build"
  say ""
  say "✓ Dry run complete. Nothing changed."
  exit 0
fi

# ─── capture rollback target ──────────────────────────────────────────────────
step "Recording rollback point"
PREV_IMAGE="$($SSH "$NAS_HOST" "sudo -n $DOCKER inspect -f '{{.Image}}' $SERVICE 2>/dev/null || true" | tr -d '[:space:]')"
if [ -n "$PREV_IMAGE" ]; then
  say "  · current image ${PREV_IMAGE#sha256:}" | cut -c1-60
else
  say "  · no running container to roll back to (first deploy?)"
  ROLLBACK=0
fi

# ─── sync code ────────────────────────────────────────────────────────────────
step "Syncing code to the NAS"

EXCLUDES=(
  --exclude '.git' --exclude 'venv' --exclude 'node_modules' --exclude '.netlify'
  --exclude '.env' --exclude 'wizarr-data' --exclude 'tautulli-config'
  --exclude 'stripe-bridge-data' --exclude '__pycache__' --exclude '.DS_Store'
  --exclude '._*' --exclude '.pytest_cache' --exclude 'dist'
)

if [ -d "$SMB_PATH" ]; then
  say "  · transport: rsync over SMB mount"
  rsync -a "${EXCLUDES[@]}" "$REPO/" "$SMB_PATH/" || die "rsync to $SMB_PATH failed"
else
  # macOS ships openrsync, which fails key auth against this NAS — tar over SSH
  # is the reliable path and needs nothing mounted.
  say "  · transport: tar over SSH (SMB not mounted)"
  # --no-xattrs/--no-mac-metadata keep bsdtar from emitting LIBARCHIVE.xattr
  # headers that the NAS's GNU tar then warns about for every single file.
  COPYFILE_DISABLE=1 tar -cf - --no-xattrs --no-mac-metadata "${EXCLUDES[@]}" -C "$REPO" . \
    | $SSH "$NAS_HOST" "tar -xf - -C $NAS_PATH" \
    || die "tar-over-ssh sync failed — NAS may hold a partial tree; rerun before rebuilding"
fi
say "  · code synced"

# Prove the bytes landed rather than trusting the transport's exit code.
REMOTE_SUM="$($SSH "$NAS_HOST" "cd $NAS_PATH && md5sum stripe-bridge/stripe_bridge/tiers.py 2>/dev/null | cut -d' ' -f1" | tr -d '[:space:]')"
LOCAL_SUM="$(md5 -q "$REPO/stripe-bridge/stripe_bridge/tiers.py" 2>/dev/null || md5sum "$REPO/stripe-bridge/stripe_bridge/tiers.py" | cut -d' ' -f1)"
[ -n "$REMOTE_SUM" ] && [ "$REMOTE_SUM" = "$LOCAL_SUM" ] \
  || die "sync verification failed: tiers.py on the NAS does not match local. NOT rebuilding."
say "  · verified: tiers.py checksum matches"

# ─── rebuild ──────────────────────────────────────────────────────────────────
step "Rebuilding $SERVICE on the NAS"
$SSH "$NAS_HOST" "cd $NAS_PATH && sudo -n $DOCKER compose up -d --build" 2>&1 | sed 's/^/  /' \
  || die "docker compose build failed — container left as-is, code is synced. Fix and rerun."

# ─── verify ───────────────────────────────────────────────────────────────────
rollback() {
  if [ "$ROLLBACK" != 1 ] || [ -z "$PREV_IMAGE" ]; then
    say ""
    say "✗ Deploy is UNHEALTHY and no rollback was performed."
    say "  Inspect: ssh $NAS_HOST 'sudo -n $DOCKER logs --tail 80 $SERVICE'"
    exit 1
  fi
  step "Health check failed — rolling back to the previous image"
  $SSH "$NAS_HOST" "cd $NAS_PATH && sudo -n $DOCKER tag $PREV_IMAGE wizteros-stripe-bridge && sudo -n $DOCKER compose up -d --no-build --force-recreate" 2>&1 | sed 's/^/  /' \
    || die "ROLLBACK FAILED — the NAS is in a bad state, intervene manually."
  [ -n "$DEPLOYED" ] && $SSH "$NAS_HOST" "printf '%s' '$DEPLOYED' > $NAS_PATH/$SHA_FILE"
  say ""
  say "✗ Deploy failed health check and was ROLLED BACK to ${PREV_IMAGE#sha256:}" | cut -c1-70
  say "  Logs from the failed build: ssh $NAS_HOST 'sudo -n $DOCKER logs --tail 80 $SERVICE'"
  exit 1
}

if [ "$SKIP_VERIFY" = 1 ]; then
  say ""
  say "⚠ Verification skipped (--skip-verify)."
else
  step "Verifying"

  # 1. container is actually running
  STATUS="$($SSH "$NAS_HOST" "sudo -n $DOCKER inspect -f '{{.State.Status}}' $SERVICE 2>/dev/null || echo missing" | tr -d '[:space:]')"
  say "  · container state: $STATUS"
  [ "$STATUS" = "running" ] || rollback

  # 2. the app answers — 401 from the admin router proves FastAPI mounted and
  #    auth is wired, which a bare port check or a 404 would not.
  PROBE=""
  for i in 1 2 3 4 5 6 7 8 9 10; do
    PROBE="$($SSH "$NAS_HOST" "curl -s -o /dev/null -m 5 -w '%{http_code}' http://localhost:8000/admin/members || true" | tr -d '[:space:]')"
    [ "$PROBE" = "401" ] && break
    sleep 3
  done
  say "  · GET /admin/members (no auth) -> ${PROBE:-no response} (expect 401)"
  [ "$PROBE" = "401" ] || rollback

  # 3. the tier drift alarm runs on the first reconcile sweep at boot; give it
  #    room to call Wizarr, then read what it said.
  say "  · waiting 25s for the boot tier-scope check to complete..."
  sleep 25
  LOGS="$($SSH "$NAS_HOST" "sudo -n $DOCKER logs --tail 120 $SERVICE 2>&1" || true)"

  if printf '%s' "$LOGS" | grep -q 'tier scope check:'; then
    say ""
    say "  ⚠ TIER SCOPE ALARM — a tier no longer resolves against the live Wizarr libraries:"
    printf '%s' "$LOGS" | grep 'tier scope check:' | sed 's/^/      /'
    say ""
    say "  The build itself is healthy; this is the drift alarm firing on data, not code."
    say "  Members cannot sign up for the listed tier(s) until the names line up."
    TIER_ALARM=1
  else
    say "  · tier scope check: no alarms — all tiers resolve"
    TIER_ALARM=0
  fi

  if printf '%s' "$LOGS" | grep -qE 'Traceback \(most recent call last\)'; then
    say "  ⚠ tracebacks present in the boot logs:"
    printf '%s' "$LOGS" | grep -A3 'Traceback' | head -20 | sed 's/^/      /'
  fi
fi

# ─── record ───────────────────────────────────────────────────────────────────
$SSH "$NAS_HOST" "printf '%s' '$LOCAL' > $NAS_PATH/$SHA_FILE"

say ""
say "═══ summary ═══"
say "deployed:  $(git rev-parse --short HEAD)  $(git log -1 --pretty=%s | cut -c1-58)"
[ -n "$DEPLOYED" ] && [ "$DEPLOYED" != "$LOCAL" ] && say "was:       ${DEPLOYED:0:7}"
say "container: $SERVICE up and answering on :8000"
if [ "${TIER_ALARM:-0}" = 1 ]; then
  say "tiers:     ⚠ ALARM — see above"
else
  say "tiers:     all resolving"
fi
say ""
say "✓ Deploy complete."
