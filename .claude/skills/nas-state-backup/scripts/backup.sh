#!/usr/bin/env bash
# Snapshot the live wizteros state on the Synology NAS into timestamped,
# verified tarballs. Everything happens NAS-side over one-shot SSH; nothing
# streams through the Mac unless --pull is given.
#
# The deploy pipeline deliberately never touches live NAS state, which means
# nothing else backs any of this up:
#   wizarr-data/         live Wizarr DB, incl. the healed library-name cache
#   tautulli-config/     live Tautulli state
#   stripe-bridge-data/  the bridge's SQLite mapping (bridge.db)
#
# .env is NEVER backed up, by design. It holds the live Stripe key, the Wizarr
# API key and SMTP credentials; a plaintext copy sitting in a backup dir (or
# pulled onto a laptop) is a secret leak, not a safety net. Rebuild it from
# .env.example if it is ever lost.
#
# The only paths this script writes to are $BACKUP_ROOT/<timestamp>/ and one
# temporary SQLite snapshot inside the stripe-bridge bind mount, which is
# removed on exit (including on failure).
set -euo pipefail

NAS_HOST="${WZ_NAS_HOST:-crivas@192.168.50.2}"
BRIDGE_PATH="${WZ_NAS_PATH:-/volume1/docker/stripe-bridge}"
WESTEROZ_PATH="${WZ_WESTEROZ_PATH:-/volume1/docker/westeroz}"
BACKUP_ROOT="${WZ_BACKUP_ROOT:-/volume1/docker/backups}"
KEEP="${WZ_BACKUP_KEEP:-7}"
PULL_DEST="${WZ_PULL_DEST:-$HOME/Backups/wizteros}"
MIN_BYTES="${WZ_MIN_ARCHIVE_BYTES:-1024}"
DOCKER="/usr/local/bin/docker"   # NOPASSWD sudoers rule matches this literal path
SERVICE="stripe-bridge"
SNAPSHOT_NAME="bridge.db.snapshot"
SSH="ssh -o BatchMode=yes -o ConnectTimeout=10"

BACKUP_ROOT="${BACKUP_ROOT%/}"

# Every state dir this knows how to back up, and every project dir it will look
# for them in. Layouts drift (stripe-bridge-data has lived in both projects), so
# nothing here assumes a dir is where it "should" be.
STATE_DIRS=(wizarr-data tautulli-config stripe-bridge-data)
SEARCH_ROOTS=("$WESTEROZ_PATH" "$BRIDGE_PATH")

DRY_RUN=0; PULL=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --pull)    PULL=1 ;;
    *) echo "unknown flag: $arg" >&2; exit 2 ;;
  esac
done

say()  { printf '%s\n' "$*"; }
step() { printf '\n▸ %s\n' "$*"; }
die()  { printf '\n✗ %s\n' "$*" >&2; exit 1; }

# Read-only remote query. Always runs, even under --dry-run: looking is not an
# action, and a dry run that cannot see the NAS cannot report a real plan.
nas() { $SSH "$NAS_HOST" "$1"; }

# Anything that changes the NAS goes through here, so --dry-run is total.
nas_write() {
  if [ "$DRY_RUN" = 1 ]; then
    say "  would run: $1"
    return 0
  fi
  $SSH "$NAS_HOST" "$1"
}

human() {
  awk -v b="$1" 'BEGIN { split("B KB MB GB TB", u, " "); i = 1;
    while (b >= 1024 && i < 5) { b /= 1024; i++ }
    printf "%.1f %s", b, u[i] }'
}

# Removes the temporary SQLite snapshot no matter how the script exits. The file
# is written by the container (root-owned), so fall back to removing it from
# inside the container when the host-side rm is refused.
SNAPSHOT_HOST_PATH=""
cleanup() {
  [ -n "$SNAPSHOT_HOST_PATH" ] || return 0
  local path="$SNAPSHOT_HOST_PATH"
  SNAPSHOT_HOST_PATH=""
  $SSH "$NAS_HOST" "rm -f '$path' 2>/dev/null || sudo -n $DOCKER exec $SERVICE rm -f /data/$SNAPSHOT_NAME" >/dev/null 2>&1 || true
}
trap cleanup EXIT

say "═══════════════════════════════════════════"
say "nas-state-backup: wizteros live NAS state"
say "═══════════════════════════════════════════"
say "nas:     $NAS_HOST"
say "backups: $BACKUP_ROOT (keep newest $KEEP)"
[ "$PULL" = 1 ] && say "pull:    $PULL_DEST"
[ "$DRY_RUN" = 1 ] && say "mode:    DRY RUN (nothing will change)"

# ─── preflight ────────────────────────────────────────────────────────────────
step "Preflight"

# Refuse a backup root that is not a real, nested path on the volume. Retention
# deletes directories under this root; a shallow root is how you rm the wrong
# thing.
case "$BACKUP_ROOT" in
  /*/*/*) ;;
  *) die "refusing backup root '$BACKUP_ROOT': needs at least three path segments (e.g. /volume1/docker/backups)" ;;
esac

case "$KEEP" in
  ''|*[!0-9]*) die "WZ_BACKUP_KEEP must be a whole number, got '$KEEP'" ;;
esac
[ "$KEEP" -ge 1 ] || die "WZ_BACKUP_KEEP must be at least 1, got '$KEEP'"

nas true 2>/dev/null || die "cannot reach $NAS_HOST over SSH (key auth). Is the NAS up / are you on the LAN?"
say "  · NAS reachable over SSH"

TS="$(date -u +%Y%m%dT%H%M%SZ)"
DEST="$BACKUP_ROOT/$TS"
say "  · snapshot id: $TS (UTC)"

# ─── locate the state dirs ────────────────────────────────────────────────────
step "Locating live state on the NAS"

PROBE=""
for root in "${SEARCH_ROOTS[@]}"; do
  for name in "${STATE_DIRS[@]}"; do
    PROBE="$PROBE[ -d '$root/$name' ] && echo '$name|$root/$name'; "
  done
done
FOUND="$(nas "$PROBE true" || true)"

found_names=(); found_paths=()
while IFS='|' read -r n p; do
  [ -n "${n:-}" ] || continue
  found_names+=("$n")
  found_paths+=("$p")
  say "  · found $n at $p"
done <<< "$FOUND"

COUNT="${#found_names[@]}"
[ "$COUNT" -gt 0 ] || die "none of ${STATE_DIRS[*]} exist under ${SEARCH_ROOTS[*]}. Nothing to back up. Check the project paths before assuming the data is gone."

for name in "${STATE_DIRS[@]}"; do
  hit=0
  i=0
  while [ "$i" -lt "$COUNT" ]; do
    [ "${found_names[$i]}" = "$name" ] && hit=1
    i=$((i + 1))
  done
  [ "$hit" = 1 ] || say "  ⚠ $name not found in any of: ${SEARCH_ROOTS[*]} (skipping, nothing to archive)"
done

# ─── consistent snapshot of the live SQLite db ────────────────────────────────
# bridge.db is written while the container runs, so tarring it raw can capture a
# torn page or miss a hot WAL. sqlite3's .backup API takes a consistent copy of a
# live database; it is run inside the container so it lands in the bind mount and
# the tar below picks it up as bridge.db.snapshot.
SNAPSHOT_NOTE="not applicable (no stripe-bridge-data found)"
i=0
while [ "$i" -lt "$COUNT" ]; do
  if [ "${found_names[$i]}" = "stripe-bridge-data" ]; then
    step "Snapshotting the live bridge database"

    STATUS="$(nas "sudo -n $DOCKER inspect -f '{{.State.Status}}' $SERVICE 2>/dev/null || echo missing" | tr -d '[:space:]')"
    say "  · $SERVICE container: $STATUS"

    if [ "$STATUS" != "running" ]; then
      SNAPSHOT_NOTE="skipped, container not running ($STATUS); bridge.db tarred directly, which is consistent because nothing is writing to it"
      say "  · $SNAPSHOT_NOTE"
      break
    fi

    # python:3.12-slim carries no sqlite3 CLI, so the python stdlib module is the
    # expected path here. The CLI branch is kept for a future base image that has
    # it. Neither form contains a double quote, so it survives the SSH quoting.
    PY="import sqlite3; src = sqlite3.connect('/data/bridge.db'); dst = sqlite3.connect('/data/$SNAPSHOT_NAME'); src.backup(dst); dst.close(); src.close()"

    if [ "$DRY_RUN" = 1 ]; then
      say "  would run: sudo -n $DOCKER exec $SERVICE <sqlite3 .backup, or python3 sqlite3.Connection.backup> -> /data/$SNAPSHOT_NAME"
      SNAPSHOT_NOTE="planned (dry run)"
      break
    fi

    if nas "sudo -n $DOCKER exec $SERVICE sh -c 'command -v sqlite3 >/dev/null 2>&1'" >/dev/null 2>&1; then
      say "  · using the sqlite3 CLI inside the container"
      nas "sudo -n $DOCKER exec $SERVICE sqlite3 /data/bridge.db \".backup '/data/$SNAPSHOT_NAME'\"" \
        || die "sqlite3 .backup failed inside $SERVICE. No backup written."
    else
      say "  · no sqlite3 binary in the image, using python3 sqlite3.Connection.backup"
      nas "sudo -n $DOCKER exec $SERVICE python3 -c \"$PY\"" \
        || die "python3 sqlite3 backup failed inside $SERVICE. No backup written."
    fi

    # The exec wrote to /data, whichever host dir that is bind-mounted from. Find
    # it rather than assuming, and register it for cleanup.
    j=0
    while [ "$j" -lt "$COUNT" ]; do
      if [ "${found_names[$j]}" = "stripe-bridge-data" ] \
        && nas "[ -f '${found_paths[$j]}/$SNAPSHOT_NAME' ]" >/dev/null 2>&1; then
        SNAPSHOT_HOST_PATH="${found_paths[$j]}/$SNAPSHOT_NAME"
      fi
      j=$((j + 1))
    done

    if [ -n "$SNAPSHOT_HOST_PATH" ]; then
      SNAP_BYTES="$(nas "wc -c < '$SNAPSHOT_HOST_PATH'" | tr -d '[:space:]')"
      SNAPSHOT_NOTE="$SNAPSHOT_NAME written ($(human "${SNAP_BYTES:-0}")), included in the archive"
      say "  · $SNAPSHOT_NOTE"
    else
      SNAPSHOT_NOTE="snapshot ran but no $SNAPSHOT_NAME landed in any stripe-bridge-data dir; the archive holds the live bridge.db only"
      say "  ⚠ $SNAPSHOT_NOTE"
    fi
    break
  fi
  i=$((i + 1))
done

# ─── archive ──────────────────────────────────────────────────────────────────
step "Writing archives to $DEST"

nas_write "mkdir -p '$DEST'" || die "could not create $DEST on the NAS"

# archives / archive_sources / archive_bytes stay index-aligned: a failed tar
# appends to none of them, so the manifest never claims an archive that is not
# there.
archives=(); archive_sources=(); archive_bytes=(); failures=0
i=0
while [ "$i" -lt "$COUNT" ]; do
  name="${found_names[$i]}"
  path="${found_paths[$i]}"
  parent="$(dirname "$path")"
  base="$(basename "$path")"
  # Namespaced by project dir so the same state dir found in two projects cannot
  # overwrite itself, and so the restore target is obvious from the filename.
  archive="$(basename "$parent")--$name.tar.gz"

  # The .env excludes are belt and braces: .env lives beside these dirs, not in
  # them. They make "no secrets in a backup" true by construction.
  nas_write "tar -czf '$DEST/$archive' --exclude '.env' --exclude '.env.*' -C '$parent' '$base'" \
    || { say "  ✗ tar failed for $path"; failures=$((failures + 1)); i=$((i + 1)); continue; }

  if [ "$DRY_RUN" = 1 ]; then
    say "  · would archive $path -> $DEST/$archive"
    archives+=("$archive"); archive_sources+=("$path"); archive_bytes+=(0)
    i=$((i + 1)); continue
  fi

  # Verify by reading the archive back, not by trusting tar's exit code: a
  # truncated write and a full disk both exit 0 often enough to matter.
  BYTES="$(nas "if tar -tzf '$DEST/$archive' >/dev/null 2>&1; then wc -c < '$DEST/$archive'; else echo -1; fi" | tr -d '[:space:]')"
  BYTES="${BYTES:--1}"

  if [ "$BYTES" = "-1" ]; then
    say "  ✗ $archive is unreadable (tar -tzf failed). Treat this backup as bad"
    failures=$((failures + 1))
  elif [ "$BYTES" -lt "$MIN_BYTES" ]; then
    say "  ✗ $archive is only $(human "$BYTES"), under the $(human "$MIN_BYTES") floor. Treat this backup as bad"
    failures=$((failures + 1))
  else
    say "  · $archive  $(human "$BYTES")  (from $path, verified)"
  fi
  archives+=("$archive"); archive_sources+=("$path"); archive_bytes+=("$BYTES")
  i=$((i + 1))
done

# A manifest so a restore months from now does not have to guess which archive
# came from where, or whether the db snapshot was taken.
MANIFEST="wizteros NAS state backup
snapshot: $TS (UTC)
host:     $NAS_HOST
db:       $SNAPSHOT_NOTE
note:     .env is deliberately not included in any archive
"
i=0
while [ "$i" -lt "${#archives[@]}" ]; do
  MANIFEST="$MANIFEST
${archives[$i]} <- ${archive_sources[$i]}"
  i=$((i + 1))
done

if [ "$DRY_RUN" = 1 ]; then
  say "  would write: $DEST/MANIFEST.txt"
else
  printf '%s\n' "$MANIFEST" | $SSH "$NAS_HOST" "cat > '$DEST/MANIFEST.txt'" \
    || say "  ⚠ could not write MANIFEST.txt (archives are still fine)"
fi

cleanup

# ─── retention ────────────────────────────────────────────────────────────────
step "Retention (keep newest $KEEP)"

EXISTING="$(nas "ls -1 '$BACKUP_ROOT' 2>/dev/null || true")"
# The name filter is the safety rail: only directories this script could have
# created are ever eligible for deletion.
SNAPS="$(printf '%s\n' "$EXISTING" | grep -E '^[0-9]{8}T[0-9]{6}Z$' | sort || true)"
NSNAPS="$(printf '%s\n' "$SNAPS" | grep -c . || true)"
NSNAPS="${NSNAPS:-0}"
[ "$DRY_RUN" = 1 ] && NSNAPS=$((NSNAPS + 1))   # the dir this run would have added

if [ "$NSNAPS" -le "$KEEP" ]; then
  say "  · $NSNAPS snapshot(s) on the NAS, nothing to prune"
else
  PRUNE="$(printf '%s\n' "$SNAPS" | head -n "$((NSNAPS - KEEP))")"
  RM_CMD=""
  while read -r d; do
    [ -n "$d" ] || continue
    say "  · pruning $BACKUP_ROOT/$d"
    RM_CMD="${RM_CMD}rm -rf '$BACKUP_ROOT/$d'; "
  done <<< "$PRUNE"
  [ -n "$RM_CMD" ] && { nas_write "$RM_CMD true" || say "  ⚠ prune failed; old snapshots are still on the NAS"; }
fi

# ─── optional pull to the Mac ─────────────────────────────────────────────────
if [ "$PULL" = 1 ]; then
  step "Pulling $TS to $PULL_DEST"
  if [ "$DRY_RUN" = 1 ]; then
    say "  would run: mkdir -p '$PULL_DEST' && ssh $NAS_HOST \"cd '$BACKUP_ROOT' && tar -cf - '$TS'\" | tar -xf - -C '$PULL_DEST'"
  else
    mkdir -p "$PULL_DEST" || die "could not create $PULL_DEST"
    # tar over SSH, matching deploy-nas: macOS ships openrsync, which fails key
    # auth against this NAS.
    $SSH "$NAS_HOST" "cd '$BACKUP_ROOT' && tar -cf - '$TS'" | tar -xf - -C "$PULL_DEST" \
      || die "pull failed. The NAS-side backup at $DEST is intact."
    [ -d "$PULL_DEST/$TS" ] || die "pull reported success but $PULL_DEST/$TS does not exist"
    say "  · local copy: $PULL_DEST/$TS ($(du -sh "$PULL_DEST/$TS" | cut -f1))"
  fi
fi

# ─── summary ──────────────────────────────────────────────────────────────────
say ""
say "═══ summary ═══"
say "snapshot:  $DEST"
say "archives:  ${#archives[@]}"
i=0
while [ "$i" -lt "${#archives[@]}" ]; do
  if [ "$DRY_RUN" = 1 ]; then
    say "  ${archives[$i]}"
  else
    say "  ${archives[$i]}  $(human "${archive_bytes[$i]}")"
  fi
  i=$((i + 1))
done
say "bridge db: $SNAPSHOT_NOTE"
[ "$PULL" = 1 ] && [ "$DRY_RUN" = 0 ] && say "pulled:    $PULL_DEST/$TS"
say ""
say "This lives on the same volume as the data it protects. If /volume1 dies,"
say "both die with it. Offsite is a separate problem, out of scope here."

if [ "$DRY_RUN" = 1 ]; then
  say ""
  say "✓ Dry run complete. Nothing changed."
  exit 0
fi

if [ "$failures" -gt 0 ]; then
  say ""
  die "$failures archive(s) failed verification. Do NOT rely on $DEST. Investigate and rerun."
fi

say ""
say "✓ Backup complete and verified."
