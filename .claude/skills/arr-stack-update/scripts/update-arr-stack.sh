#!/usr/bin/env bash
# Update the *arr media stack containers on the Synology docker hosts to their
# latest images: pull, recreate only what actually changed, prove each service
# answers again, and roll a service back to its previous image if it does not.
#
# Deliberately excluded from the default service set (live state, or not ours):
#   wizarr        - live member DB + healed library-name cache; snapshot first
#                   (nas-state-backup) and prefer the wizarr-upgrade skill
#   tautulli      - live history DB; snapshot first (nas-state-backup)
#   stripe-bridge - built from this repo, not pulled; owned by the deploy-nas skill
#
# Targets /bin/bash 3.2 (what macOS ships): no associative arrays, no mapfile.
set -euo pipefail

DOCKER_BIN="/usr/local/bin/docker"   # not on the non-interactive PATH; sudoers matches this literal
# How snippets invoke docker on the current host. On a NOPASSWD host the rule
# covers only the docker path, not bash, so the remote shell stays unprivileged
# and sudo wraps each docker call; set per host right after probe_host.
DOCKER="$DOCKER_BIN"
SSH="ssh -o BatchMode=yes -o ConnectTimeout=10"
KEYCHAIN_SERVICE="${WZ_NAS_KEYCHAIN:-synology-nas}"

# Only these two boxes run docker. Each keeps its media stack in one compose
# project, discovered at runtime from container labels rather than hardcoded.
ALL_HOSTS="meleys vermithor"
STATEFUL="wizarr tautulli"
NEVER="stripe-bridge"

# A service is "up" if it answers at all — some *arr UIs 200, some redirect to a
# login, some 401. Only a connection failure or a 5xx means broken.
OK_CODES="200 201 204 301 302 303 307 308 400 401 403"

CHECK_ONLY=0; INCLUDE_STATEFUL=0; PRUNE=0; ROLLBACK=1; READY_TIMEOUT=120
HOSTS=""; ONLY_SERVICES=""

usage() {
  cat <<'EOF'
usage: update-arr-stack.sh <host|all> [flags]

  host            meleys | vermithor | all

  --check                 Pull images and report what is newer; do not recreate
  --services "a b"        Update only these compose services
  --include-stateful      Also update wizarr and tautulli (snapshot them first)
  --prune                 Remove the superseded images afterwards
  --no-rollback           Leave a failing service on the new image
  --timeout <seconds>     Readiness wait per service (default 120)
EOF
}

say()  { printf '%s\n' "$*"; }
step() { printf '\n▸ %s\n' "$*"; }
die()  { printf '\n✗ %s\n' "$*" >&2; exit 1; }

# Returns 0 when the first argument appears in the remaining ones.
in_list() {
  needle="$1"; shift
  for item in "$@"; do [ "$item" = "$needle" ] && return 0; done
  return 1
}

# Maps a host alias to its ssh target, overridable for a different LAN.
ssh_target() {
  case "$1" in
    meleys)    printf '%s' "${WZ_MELEYS_SSH:-crivas@192.168.50.2}" ;;
    vermithor) printf '%s' "${WZ_VERMITHOR_SSH:-crivas@192.168.50.3}" ;;
    *)         die "unknown host: $1 (docker runs only on meleys and vermithor)" ;;
  esac
}

while [ $# -gt 0 ]; do
  case "$1" in
    meleys|vermithor)   HOSTS="$HOSTS $1" ;;
    all)                HOSTS="$ALL_HOSTS" ;;
    --check)            CHECK_ONLY=1 ;;
    --services)         shift; ONLY_SERVICES="${1:-}" ;;
    --include-stateful) INCLUDE_STATEFUL=1 ;;
    --prune)            PRUNE=1 ;;
    --no-rollback)      ROLLBACK=0 ;;
    --timeout)          shift; READY_TIMEOUT="${1:-120}" ;;
    -h|--help)          usage; exit 0 ;;
    *)                  usage >&2; die "unknown argument: $1" ;;
  esac
  shift
done

[ -n "${HOSTS// /}" ] || { usage >&2; die "no host given"; }

# ─── remote execution ─────────────────────────────────────────────────────────
HOST_NOPASSWD=0
HOST_PW=""

# Reads the current host's sudo password from the login keychain, where the
# `nas` helper stores it. Each NAS has its own password; they are not shared.
host_password() {
  host="$1"
  if [ -z "$HOST_PW" ]; then
    var="WZ_NAS_PASSWORD_${host}"
    pw="$(eval "printf '%s' \"\${$var:-}\"")"
    [ -n "$pw" ] || pw="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a "$host" -w 2>/dev/null || true)"
    [ -n "$pw" ] || pw="$(security find-generic-password -s "$KEYCHAIN_SERVICE" -a crivas -w 2>/dev/null || true)"
    [ -n "$pw" ] || die "$host needs a sudo password and none is stored. Run: nas setpw $host  (or set WZ_NAS_PASSWORD_${host})"
    HOST_PW="$pw"
  fi
  printf '%s' "$HOST_PW"
}

# Runs a shell snippet on a host. The snippet is base64-encoded in transit so
# quoting, newlines, and Go template braces survive the trip. On a NOPASSWD
# host the shell runs as the login user and $DOCKER carries the sudo; on a
# password host the whole snippet runs under sudo -S instead.
run_remote() {
  host="$1"; snippet="$2"
  b64="$(printf '%s' "$snippet" | base64 | tr -d '\n')"
  if [ "$HOST_NOPASSWD" = 1 ]; then
    $SSH "$(ssh_target "$host")" "echo $b64 | base64 -d | bash"
  else
    # sudo -S eats one line of stdin for the password; bash reads the script
    # from the temp file, so the two do not fight over the same stream.
    host_password "$host" | $SSH "$(ssh_target "$host")" \
      "f=\$(mktemp); echo $b64 | base64 -d >\$f; sudo -S -p '' bash \$f; rc=\$?; rm -f \$f; exit \$rc"
  fi
}

docker_on() { host="$1"; shift; run_remote "$host" "$DOCKER $*"; }

probe_host() {
  host="$1"
  $SSH "$(ssh_target "$host")" true 2>/dev/null \
    || die "cannot reach $host ($(ssh_target "$host")) over SSH. Is the NAS up, are you on the LAN?"
  HOST_PW=""
  if $SSH "$(ssh_target "$host")" "sudo -n $DOCKER_BIN ps -q >/dev/null 2>&1"; then
    HOST_NOPASSWD=1
    DOCKER="sudo -n $DOCKER_BIN"
  else
    HOST_NOPASSWD=0
    DOCKER="$DOCKER_BIN"
    host_password "$host" >/dev/null   # fail fast, before anything is pulled
  fi
}

SUMMARY=""
EXIT_CODE=0

note() { SUMMARY="${SUMMARY}$*
"; }

# ─── per host ─────────────────────────────────────────────────────────────────
update_host() {
  host="$1"

  say "═══════════════════════════════════════════"
  say "arr-stack-update — $host"
  say "═══════════════════════════════════════════"
  [ "$CHECK_ONLY" = 1 ] && say "mode:  CHECK (pull only, containers untouched)"

  step "Preflight"
  probe_host "$host"
  say "  · reachable; docker sudo $([ "$HOST_NOPASSWD" = 1 ] && echo 'passwordless' || echo 'via stored password')"

  # ─── discover the stack from container labels ───────────────────────────────
  step "Discovering the compose stack"
  inventory="$(docker_on "$host" "ps -a --format '{{.Names}}\t{{.Label \"com.docker.compose.service\"}}\t{{.Label \"com.docker.compose.project.working_dir\"}}\t{{.Image}}\t{{.Ports}}'")"

  names=(); services=(); images=(); ports=(); workdir=""
  while IFS=$'\t' read -r name svc dir image portspec; do
    [ -n "${svc:-}" ] && [ -n "${dir:-}" ] || continue
    in_list "$name" $NEVER && continue
    if [ -n "$ONLY_SERVICES" ]; then
      in_list "$svc" $ONLY_SERVICES || continue
    elif [ "$INCLUDE_STATEFUL" = 0 ] && in_list "$svc" $STATEFUL; then
      say "  · skipping $svc (live state — use --include-stateful, and snapshot it first)"
      continue
    fi
    workdir="$dir"
    port="$(printf '%s' "${portspec:-}" | sed -n 's/.*0\.0\.0\.0:\([0-9]*\)->.*/\1/p' | head -1)"
    names[${#names[@]}]="$name"
    services[${#services[@]}]="$svc"
    images[${#images[@]}]="$image"
    ports[${#ports[@]}]="${port:-}"
  done <<<"$inventory"

  if [ ${#names[@]} -eq 0 ]; then
    say "  · nothing to update on $host"
    note "$host: no matching services"
    return 0
  fi
  say "  · project dir: $workdir"
  say "  · services: ${services[*]}"

  # docker ps's Image column degrades to a bare image ID once a newer pull has
  # moved the tag (exactly the state a prior --check leaves behind), which made
  # the change detection compare the old image against itself. Config.Image
  # keeps the tag reference the container was created with, so use that.
  refs="$(run_remote "$host" "for c in ${names[*]}; do $DOCKER inspect -f '{{.Config.Image}}' \$c 2>/dev/null || echo NONE; done")"
  images=()
  while IFS= read -r ref; do images[${#images[@]}]="$ref"; done <<<"$refs"

  # ─── record the rollback point ──────────────────────────────────────────────
  # One line per container, NONE on failure, so the output stays index-aligned
  # with the arrays above even when a container is missing.
  old_ids=()
  before="$(run_remote "$host" "for c in ${names[*]}; do $DOCKER inspect -f '{{.Image}}' \$c 2>/dev/null || echo NONE; done")"
  while IFS= read -r id; do old_ids[${#old_ids[@]}]="$id"; done <<<"$before"

  # ─── pull ───────────────────────────────────────────────────────────────────
  step "Pulling latest images"
  run_remote "$host" "cd '$workdir' && $DOCKER compose pull ${services[*]}" 2>&1 |
    grep -Ei 'pulled|error|denied|not found' | sed 's/^/  /' || true

  # ─── which tags actually moved ──────────────────────────────────────────────
  changed=""
  after="$(run_remote "$host" "for r in ${images[*]}; do $DOCKER image inspect -f '{{.Id}}' \$r 2>/dev/null || echo NONE; done")"
  i=0
  while IFS= read -r new_id; do
    if [ "$new_id" != "NONE" ] && [ "$new_id" != "${old_ids[$i]:-}" ]; then
      changed="$changed ${services[$i]}"
    fi
    i=$((i + 1))
  done <<<"$after"
  changed="${changed# }"

  step "Comparing"
  i=0
  while [ "$i" -lt ${#services[@]} ]; do
    if in_list "${services[$i]}" $changed; then
      say "  · ${services[$i]}: NEW image available"
    else
      say "  · ${services[$i]}: already current"
    fi
    i=$((i + 1))
  done

  if [ -z "$changed" ]; then
    say ""
    say "✓ $host: every service is already on the latest image. Nothing recreated."
    note "$host: already current (${#services[@]} services)"
    return 0
  fi

  if [ "$CHECK_ONLY" = 1 ]; then
    say ""
    say "✓ $host: newer images pulled for — $changed"
    say "  Containers were NOT recreated (--check)."
    note "$host: updates available — $changed (checked only)"
    return 0
  fi

  # ─── recreate ───────────────────────────────────────────────────────────────
  step "Recreating: $changed"
  run_remote "$host" "cd '$workdir' && $DOCKER compose up -d $changed" 2>&1 | sed 's/^/  /' \
    || die "$host: compose up failed. Containers may be partly recreated — inspect before rerunning."

  # ─── verify, and roll back only what failed ─────────────────────────────────
  step "Verifying"
  i=0
  while [ "$i" -lt ${#names[@]} ]; do
    if ! in_list "${services[$i]}" $changed; then i=$((i + 1)); continue; fi
    n="${names[$i]}"; s="${services[$i]}"; p="${ports[$i]}"; ok=0; code=""

    state="$(docker_on "$host" "inspect -f '{{.State.Status}}' $n 2>/dev/null || echo missing" | tr -d '[:space:]')"
    if [ "$state" != "running" ]; then
      say "  · $s: container state $state ✗"
    elif [ -z "$p" ]; then
      say "  · $s: running (no published port to probe)"
      ok=1
    else
      waited=0
      while [ "$waited" -lt "$READY_TIMEOUT" ]; do
        code="$($SSH "$(ssh_target "$host")" "curl -s -o /dev/null -m 5 -w '%{http_code}' http://localhost:$p/ || true" | tr -d '[:space:]')"
        in_list "${code:-000}" $OK_CODES && { ok=1; break; }
        sleep 5; waited=$((waited + 5))
      done
      if [ "$ok" = 1 ]; then
        say "  · $s: running, :$p -> HTTP $code ✓"
      else
        say "  · $s: running, :$p -> ${code:-no response} after ${waited}s ✗"
      fi
    fi

    if [ "$ok" = 1 ]; then
      version="$(run_remote "$host" "$DOCKER logs --tail 400 $n 2>&1 | grep -oE 'Version [0-9][0-9.]*' | tail -1" | tr -d '\r' || true)"
      say "    ${version:-version not reported in logs}"
      note "$host/$s: updated${version:+ ($version)}"
    else
      EXIT_CODE=1
      old="${old_ids[$i]:-NONE}"
      if [ "$ROLLBACK" != 1 ] || [ "$old" = "NONE" ]; then
        say "    ✗ not rolled back. Logs: ssh $(ssh_target "$host") 'sudo $DOCKER_BIN logs --tail 80 $n'"
        note "$host/$s: FAILED, left on the new image"
      else
        say "    rolling back to ${old#sha256:}"
        run_remote "$host" "cd '$workdir' && $DOCKER tag $old '${images[$i]}' && $DOCKER compose up -d --force-recreate $s" 2>&1 | sed 's/^/      /' \
          || die "$host: ROLLBACK FAILED for $s — intervene manually."
        note "$host/$s: FAILED health check, ROLLED BACK"
      fi
    fi
    i=$((i + 1))
  done

  if [ "$PRUNE" = 1 ]; then
    step "Pruning superseded images"
    docker_on "$host" "image prune -f" 2>&1 | sed 's/^/  /' || true
  else
    say ""
    say "  Superseded images are kept as the rollback path. Reclaim with --prune."
  fi

  say ""
  say "✓ $host complete."
}

for h in $HOSTS; do
  update_host "$h"
  say ""
done

say "═══ summary ═══"
printf '%s' "${SUMMARY:-nothing to report
}"
if [ "$EXIT_CODE" != 0 ]; then
  say ""
  say "✗ One or more services failed verification — see above."
fi
exit "$EXIT_CODE"
