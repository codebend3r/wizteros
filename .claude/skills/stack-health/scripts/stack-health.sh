#!/usr/bin/env bash
# Read-only health probe of the whole wizteros paid-access path:
#
#   Stripe -> Tailscale Funnel -> stripe-bridge -> Wizarr -> Plex
#
# THIS SCRIPT CHANGES NOTHING. Every NAS call is an inspect, a compose ps, a
# cat, a df or a docker logs read. The single write anywhere is `git fetch`
# updating this clone's remote-tracking refs in check 5. There are no mutating
# flags and deliberately no way to make it deploy, restart, rebuild or edit
# anything: when a check says the NAS is behind, run the deploy-nas skill.
#
# The POST in check 4 is safe by construction: the bridge verifies the Stripe
# signature before touching Wizarr or the store, so a garbage body is rejected
# with 400 "invalid signature" and no side effect.
#
# Conventions are lifted from deploy-nas.sh on purpose: WZ_* env-overridable
# constants, say/die helpers, one-shot SSH invocations, and the literal sudo
# docker path that the NOPASSWD sudoers rule matches.
set -euo pipefail

# This script lives at <repo>/.claude/skills/stack-health/scripts/, so the repo
# root is four levels up. No hardcoded path, works from any clone or worktree.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="${WZ_REPO:-$(cd "$SCRIPT_DIR/../../../.." && pwd)}"
NAS_HOST="${WZ_NAS_HOST:-crivas@192.168.50.2}"
NAS_IP="${WZ_NAS_IP:-192.168.50.2}"
NAS_PATH="${WZ_NAS_PATH:-/volume1/docker/stripe-bridge}"
WESTEROZ_PATH="${WZ_WESTEROZ_PATH:-/volume1/docker/westeroz}"
DOCKER="/usr/local/bin/docker"   # NOPASSWD sudoers rule matches this literal path
SERVICE="${WZ_SERVICE:-stripe-bridge}"
BRIDGE_PORT="${WZ_BRIDGE_PORT:-8000}"
WIZARR_PORT="${WZ_WIZARR_PORT:-5690}"
SHA_FILE=".deployed-sha"
VOLUME="${WZ_VOLUME:-/volume1}"
DISK_WARN="${WZ_DISK_WARN:-85}"
LOG_LINES="${WZ_LOG_LINES:-200}"
ENV_FILE="${WZ_ENV_FILE:-$REPO/.env}"
ENV_EXAMPLE="${WZ_ENV_EXAMPLE:-$REPO/.env.example}"
PUBLIC_BASE="${WZ_PUBLIC_BASE:-}"
HTTP_TIMEOUT="${WZ_HTTP_TIMEOUT:-8}"
FUNNEL_TIMEOUT="${WZ_FUNNEL_TIMEOUT:-15}"
# LogLevel=ERROR drops OpenSSH's per-connection post-quantum advisory, which this
# NAS triggers on every one of the seven SSH calls below and which otherwise lands
# in the middle of check 3's compose ps block. Real connection failures are logged
# at ERROR, so they still print; a readable transcript is the whole product here.
SSH="ssh -o BatchMode=yes -o ConnectTimeout=10 -o LogLevel=ERROR"

say()  { printf '%s\n' "$*"; }
die()  { printf '\n✗ %s\n' "$*" >&2; exit 1; }
note() { printf '  · %s\n' "$*"; }

# ─── check bookkeeping ────────────────────────────────────────────────────────
# FAILED drives the exit code. WARNED never does: a warning means "working, but
# worth knowing" (the NAS is behind, the volume is filling up), and a health
# probe that exits nonzero for those cannot be trusted to mean anything.
#
# SKIPPED does not change the exit code either, but it must change the wording:
# a skipped check was never probed, so a run that skipped the ingress check has
# not established that Stripe can reach us and may not be summarised as
# "everything passed".
FAILED=0
WARNED=0
SKIPPED=0
RESULTS=""
CHECK_N=""
CHECK_LABEL=""

check()   { CHECK_N="$1"; CHECK_LABEL="$2"; printf '\n▸ %s. %s\n' "$1" "$2"; }
verdict() { RESULTS="${RESULTS}  ${1} ${CHECK_N}. ${CHECK_LABEL}: ${2}"$'\n'; }
pass()    { printf '  ✓ %s\n' "$*"; verdict "✓" "$*"; }
warn()    { printf '  ⚠ %s\n' "$*"; WARNED=$((WARNED + 1)); verdict "⚠" "$*"; }
fail()    { printf '  ✗ %s\n' "$*"; FAILED=$((FAILED + 1)); verdict "✗" "$*"; }
skipped() { printf '  · skipped (%s)\n' "$*"; SKIPPED=$((SKIPPED + 1)); verdict "·" "NOT PROBED, skipped ($*)"; }

# HTTP status from this machine. curl still writes the code on failure, so a
# refused connection or a timeout reports 000 rather than an empty string.
http_code() {
  local timeout="$1" url="$2"
  shift 2
  curl -s -o /dev/null -m "$timeout" -w '%{http_code}' "$@" "$url" 2>/dev/null | tr -d '[:space:]' || true
}

# One-shot SSH, mirroring deploy-nas.sh: never an interactive two-step, because
# a bare local `cd /volume1/...` hits the Mac's zoxide alias and fails.
nas_container_state() {
  $SSH "$NAS_HOST" "sudo -n $DOCKER inspect -f '{{.State.Status}}' $1 2>/dev/null || echo missing" \
    | tr -d '[:space:]'
}

# ─── flags ────────────────────────────────────────────────────────────────────
QUICK=0
for arg in "$@"; do
  case "$arg" in
    --quick) QUICK=1 ;;
    -h|--help)
      say "stack-health.sh [--quick] [-h|--help]"
      say ""
      say "Read-only health probe of the wizteros production stack. Changes nothing."
      say ""
      say "  --quick     skip check 4 (public ingress) and check 8 (env drift)"
      say "  -h, --help  print this and exit 0"
      say ""
      say "Exit 0 when every check passed (warnings allowed), 1 when any check failed."
      say "A skipped check is not a pass; the summary says so and the exit stays 0."
      exit 0
      ;;
    *) echo "unknown flag: $arg (this probe is read-only; there are no mutating flags)" >&2; exit 2 ;;
  esac
done

say "═══════════════════════════════════════════"
say "stack-health: wizteros production probe"
say "═══════════════════════════════════════════"
say "repo:  $REPO"
say "nas:   $NAS_HOST"
say "mode:  READ ONLY (nothing will change)"
[ "$QUICK" = 1 ] && say "       quick (skipping ingress + env drift)"

[ -d "$REPO" ] || die "repo not found: $REPO"
cd "$REPO"

# ─── 1. NAS reachable ─────────────────────────────────────────────────────────
check 1 "NAS reachable over SSH"

SSH_OK=0
if $SSH "$NAS_HOST" true 2>/dev/null; then
  SSH_OK=1
  pass "$NAS_HOST answers key auth"
else
  fail "cannot reach $NAS_HOST (key auth). NAS down, off the LAN, or key not loaded."
fi

# ─── 2. Bridge container + liveness ───────────────────────────────────────────
check 2 "stripe-bridge container and liveness"

BRIDGE_STATE="unknown"
if [ "$SSH_OK" = 1 ]; then
  BRIDGE_STATE="$(nas_container_state "$SERVICE")"
  note "container state: $BRIDGE_STATE"
else
  note "container state: unverifiable (no SSH)"
fi

# 401 is the liveness probe, not 200. There is no /health route; /admin/members
# returning 401 proves FastAPI mounted the router and auth is wired, which a
# bare port check or a 404 would not.
BRIDGE_PROBE="$(http_code "$HTTP_TIMEOUT" "http://$NAS_IP:$BRIDGE_PORT/admin/members")"
note "GET http://$NAS_IP:$BRIDGE_PORT/admin/members -> ${BRIDGE_PROBE:-no response} (expect 401)"

if [ "$BRIDGE_STATE" = "running" ] && [ "$BRIDGE_PROBE" = "401" ]; then
  pass "bridge is running and answering on :$BRIDGE_PORT"
elif [ "$SSH_OK" = 0 ] && [ "$BRIDGE_PROBE" = "401" ]; then
  warn "bridge answers on :$BRIDGE_PORT, but container state is unverifiable without SSH"
elif [ "$BRIDGE_PROBE" != "401" ]; then
  fail "bridge is not answering (state $BRIDGE_STATE, probe ${BRIDGE_PROBE:-none}). Stripe webhooks are dying."
else
  fail "container state is '$BRIDGE_STATE', not running"
fi

# ─── 3. Westeroz containers ───────────────────────────────────────────────────
check 3 "westeroz project (wizarr, tautulli)"

WIZARR_STATE="unknown"
TAUTULLI_STATE="unknown"
if [ "$SSH_OK" = 1 ]; then
  COMPOSE_PS="$($SSH "$NAS_HOST" "cd $WESTEROZ_PATH && sudo -n $DOCKER compose ps 2>&1" || true)"
  note "compose ps in $WESTEROZ_PATH:"
  printf '%s\n' "$COMPOSE_PS" | sed 's/^/      /'
  # The verdict comes from a direct inspect rather than parsing the ps table:
  # the column layout differs between compose v1 and v2 and is not worth
  # depending on, while inspect returns one bare word on every version.
  WIZARR_STATE="$(nas_container_state wizarr)"
  TAUTULLI_STATE="$(nas_container_state tautulli)"
  note "wizarr:   $WIZARR_STATE"
  note "tautulli: $TAUTULLI_STATE"
else
  note "compose ps: unverifiable (no SSH)"
fi

# Any HTTP answer counts. Wizarr redirects unauthenticated callers (302), so
# insisting on 200 would report a healthy Wizarr as broken.
WIZARR_PROBE="$(http_code "$HTTP_TIMEOUT" "http://$NAS_IP:$WIZARR_PORT/")"
note "GET http://$NAS_IP:$WIZARR_PORT/ -> ${WIZARR_PROBE:-no response} (any answer is fine)"

WIZARR_ANSWERS=1
case "$WIZARR_PROBE" in
  ""|000|5??) WIZARR_ANSWERS=0 ;;
esac

WZ_PROBLEMS=""
if [ "$SSH_OK" = 1 ]; then
  [ "$WIZARR_STATE" = "running" ]   || WZ_PROBLEMS="${WZ_PROBLEMS}wizarr=$WIZARR_STATE "
  [ "$TAUTULLI_STATE" = "running" ] || WZ_PROBLEMS="${WZ_PROBLEMS}tautulli=$TAUTULLI_STATE "
fi
[ "$WIZARR_ANSWERS" = 1 ] || WZ_PROBLEMS="${WZ_PROBLEMS}:$WIZARR_PORT=${WIZARR_PROBE:-no response} "

if [ -n "$WZ_PROBLEMS" ]; then
  fail "westeroz unhealthy: $WZ_PROBLEMS(invites cannot be created or redeemed)"
elif [ "$SSH_OK" = 0 ]; then
  warn "Wizarr answering on :$WIZARR_PORT, but container states are unverifiable without SSH"
else
  pass "wizarr and tautulli running, Wizarr answering on :$WIZARR_PORT"
fi

# ─── 4. Public ingress ────────────────────────────────────────────────────────
check 4 "public ingress (Tailscale Funnel)"

if [ "$QUICK" = 1 ]; then
  skipped "--quick"
else
  BASE_SRC="WZ_PUBLIC_BASE"
  if [ -z "$PUBLIC_BASE" ] && [ -f "$ENV_FILE" ]; then
    BASE_SRC="$ENV_FILE"
    PUBLIC_BASE="$(grep -E '^[[:space:]]*PUBLIC_INVITE_BASE[[:space:]]*=' "$ENV_FILE" 2>/dev/null \
      | tail -1 | cut -d= -f2- | tr -d '"'"'" | tr -d '[:space:]' || true)"
  fi
  PUBLIC_BASE="${PUBLIC_BASE%/}"

  if [ -z "$PUBLIC_BASE" ]; then
    skipped "no PUBLIC_INVITE_BASE: set WZ_PUBLIC_BASE or add a .env at $ENV_FILE"
  else
    note "base: $PUBLIC_BASE (from $BASE_SRC)"
    ROOT_PROBE="$(http_code "$FUNNEL_TIMEOUT" "$PUBLIC_BASE/")"
    note "GET  $PUBLIC_BASE/ -> ${ROOT_PROBE:-no response}"

    # Funnel mounts the bridge under /stripe and strips the prefix, so the
    # bridge sees /webhook. The healthy answer is exactly 400: the handler
    # verifies the Stripe signature before anything else and raises
    # HTTPException(400, "invalid signature"), so only the bridge itself
    # produces a 400 here.
    HOOK_PROBE="$(http_code "$FUNNEL_TIMEOUT" "$PUBLIC_BASE/stripe/webhook" \
      -X POST -H 'Content-Type: application/json' -d '{"stack-health":"probe"}')"
    note "POST $PUBLIC_BASE/stripe/webhook (garbage body) -> ${HOOK_PROBE:-no response} (expect 400)"

    case "$ROOT_PROBE" in
      ""|000) fail "Funnel unreachable from this machine. Stripe webhooks are silently dying." ;;
      *)
        # Match on the exact code, never on a 4?? glob. Wizarr sits at the
        # Funnel root, so a broken /stripe mount does not time out: the request
        # falls through to Wizarr, which answers 404. That 404 is precisely the
        # failure docs/tailscale-funnel.md warns about, and a 4?? glob would
        # report it as a healthy mount.
        case "$HOOK_PROBE" in
          400) pass "Funnel up and the bridge owns the webhook route (rejected the unsigned body with 400)" ;;
          404) fail "404 on the webhook route: the /stripe mount is not reaching the bridge, so the request fell through to Wizarr. Stripe cannot deliver (see docs/tailscale-funnel.md)." ;;
          405) fail "405 on the webhook route: something other than the bridge's POST handler is answering /stripe/webhook. Stripe cannot deliver (see docs/tailscale-funnel.md)." ;;
          ""|000) fail "webhook route timed out through the Funnel. Stripe deliveries are failing." ;;
          4??) warn "webhook route returned $HOOK_PROBE, not the bridge's own 400. Something is answering in front of the bridge; confirm a real delivery in Stripe's webhook attempts." ;;
          *) fail "webhook route returned $HOOK_PROBE, not the bridge's 400. The /stripe mount is wrong; Stripe cannot deliver." ;;
        esac
        ;;
    esac
  fi
fi

# ─── 5. Deployed SHA ──────────────────────────────────────────────────────────
check 5 "deployed SHA vs origin/main"

if [ "$SSH_OK" = 0 ]; then
  fail "unverifiable: no SSH to read $NAS_PATH/$SHA_FILE"
else
  DEPLOYED="$($SSH "$NAS_HOST" "cat $NAS_PATH/$SHA_FILE 2>/dev/null || true" | tr -d '[:space:]')"
  git fetch --quiet origin main 2>/dev/null || note "could not fetch origin; comparing against the local origin/main ref"
  ORIGIN="$(git rev-parse origin/main 2>/dev/null || true)"

  if [ -z "$DEPLOYED" ]; then
    warn "NAS has no $SHA_FILE marker: the deploy-nas skill has never run here"
  elif [ -z "$ORIGIN" ]; then
    fail "no origin/main ref in this clone, cannot compare against ${DEPLOYED:0:7}"
  else
    note "NAS .deployed-sha: ${DEPLOYED:0:7}"
    note "origin/main:       ${ORIGIN:0:7}"
    if [ "$DEPLOYED" = "$ORIGIN" ]; then
      pass "NAS is current with origin/main"
    elif git cat-file -e "$DEPLOYED^{commit}" 2>/dev/null; then
      # `rev-list --count A..B` counts what B has and A lacks, which only means
      # "how far behind" while the deployed SHA is an ancestor of origin/main.
      # After a history rewrite both counts are nonzero, and reporting BEHIND on
      # its own hides the divergence and overstates the pending change by every
      # rewritten commit. Ask about ancestry explicitly instead of inferring it.
      BEHIND="$(git rev-list --count "$DEPLOYED..$ORIGIN" 2>/dev/null || echo '?')"
      AHEAD="$(git rev-list --count "$ORIGIN..$DEPLOYED" 2>/dev/null || echo '?')"
      if [ "$AHEAD" != "0" ] && [ "$BEHIND" != "0" ]; then
        # Diverged. Say which kind, because they are not equally alarming: a
        # rebase still shares a base, whereas a rewritten root shares nothing and
        # both counts then just restate each history's full length.
        MERGE_BASE="$(git merge-base "$DEPLOYED" "$ORIGIN" 2>/dev/null || true)"
        # The counts describe SHAs, not work, so report what actually differs in
        # the paths the NAS builds from. Same list as deploy-nas.sh's NAS_PATHS.
        DRIFT_FILES="$(git diff --name-only "$DEPLOYED" "$ORIGIN" \
          -- apps/stripe-bridge docker-compose.yml scripts package.json 2>/dev/null \
          | grep -c . || true)"
        if [ -z "$MERGE_BASE" ]; then
          note "common ancestor:   none, the two histories share no commits"
          note "NAS-built files differing: ${DRIFT_FILES:-unknown}"
          warn "NAS marker is on an UNRELATED history, not simply behind: the whole history was rewritten (new root), so its $AHEAD commit(s) and origin/main's $BEHIND are two disjoint graphs and neither number means pending work. ${DRIFT_FILES:-?} NAS-built file(s) actually differ. deploy-nas resyncs the marker."
        else
          note "common ancestor:   ${MERGE_BASE:0:7}"
          note "NAS-built files differing: ${DRIFT_FILES:-unknown}"
          warn "NAS is on a DIVERGED history, not simply behind: $AHEAD commit(s) origin/main does not contain, $BEHIND commit(s) it has that the NAS lacks, since ${MERGE_BASE:0:7}. ${DRIFT_FILES:-?} NAS-built file(s) actually differ, which is the number that matters. deploy-nas resyncs the marker."
        fi
      elif [ "$BEHIND" != "0" ]; then
        warn "NAS is behind origin/main by $BEHIND commit(s). Run the deploy-nas skill to ship."
      else
        warn "NAS is on a SHA that is $AHEAD commit(s) ahead of origin/main (a force push, or a hand deploy)"
      fi
    else
      warn "deployed SHA ${DEPLOYED:0:7} is unknown to this clone. Fetch, or the NAS ran a branch that never landed."
    fi
  fi
fi

# ─── 6. Bridge logs ───────────────────────────────────────────────────────────
check 6 "recent bridge logs (last $LOG_LINES lines)"

if [ "$SSH_OK" = 0 ]; then
  fail "unverifiable: no SSH to read $SERVICE logs"
else
  LOGS="$($SSH "$NAS_HOST" "sudo -n $DOCKER logs --tail $LOG_LINES $SERVICE 2>&1" || true)"

  # The bridge logs three different 'tier scope check' lines and they do NOT mean
  # the same thing (see check_tier_scopes and _reconcile_loop in
  # apps/stripe-bridge/stripe_bridge/stripe_wizarr_bridge.py):
  #
  #   "tier scope check: <tier> -> <reason>"                    real drift alarm
  #   "tier scope check: could not read libraries from Wizarr"  check could not run
  #   "tier scope check failed"                                 check could not run
  #
  # Only the first means a tier stopped resolving. check_tier_scopes deliberately
  # returns healthy when Wizarr is unreachable ("unreachable is not
  # misconfigured"), so failing the probe on the other two would turn a passing
  # Wizarr blip into "signups create wrongly scoped invites", a different and
  # wrong diagnosis, on a stack where nothing is actually misconfigured.
  TIER_ALARM=0
  TIER_UNRAN=0
  if printf '%s' "$LOGS" | grep -qE 'tier scope check: .+ -> '; then
    say ""
    say "  ⚠ TIER SCOPE ALARM: a tier no longer resolves against the live Wizarr libraries."
    printf '%s' "$LOGS" | grep -E 'tier scope check: .+ -> ' | sed 's/^/      /'
    say ""
    TIER_ALARM=1
  fi
  if printf '%s' "$LOGS" | grep -qE 'tier scope check: could not read|tier scope check failed'; then
    say "  ⚠ the tier scope check could not run on at least one sweep:"
    printf '%s' "$LOGS" | grep -E 'tier scope check: could not read|tier scope check failed' \
      | tail -5 | sed 's/^/      /'
    TIER_UNRAN=1
  fi

  TRACEBACKS="$(printf '%s' "$LOGS" | grep -c 'Traceback (most recent call last)' || true)"
  TRACEBACKS="${TRACEBACKS:-0}"
  if [ "$TRACEBACKS" != "0" ]; then
    say "  ⚠ $TRACEBACKS traceback(s) in the last $LOG_LINES lines:"
    # `|| true` because head closing the pipe early SIGPIPEs grep, and pipefail
    # would otherwise take the whole probe down on a long traceback.
    printf '%s' "$LOGS" | grep -A3 'Traceback' | head -20 | sed 's/^/      /' || true
  fi

  if [ "$TIER_ALARM" = 1 ]; then
    fail "tier scope alarm firing: signups for the named tier(s) create wrongly scoped invites"
  elif [ "$TIER_UNRAN" = 1 ]; then
    warn "the tier scope check could not reach Wizarr on a recent sweep, so drift is currently unverified (the bridge treats this as healthy and retries)"
  elif [ "$TRACEBACKS" != "0" ]; then
    warn "$TRACEBACKS traceback(s) in the logs. Read the excerpt: one bad webhook is not the same as a broken bridge."
  else
    pass "no tier alarms, no tracebacks"
  fi
fi

# ─── 7. Disk ──────────────────────────────────────────────────────────────────
check 7 "disk usage of $VOLUME"

if [ "$SSH_OK" = 0 ]; then
  fail "unverifiable: no SSH to run df on $VOLUME"
else
  DF_RAW="$($SSH "$NAS_HOST" "df -Pk $VOLUME 2>/dev/null | tail -1" || true)"
  DF_PCT="$(printf '%s\n' "$DF_RAW" | awk '{print $5}' | tr -d '%[:space:]')"
  DF_HUMAN="$(printf '%s\n' "$DF_RAW" | awk '{ if ($2 > 0) printf "%.1fT free of %.1fT", $4/1073741824, $2/1073741824 }')"

  case "$DF_PCT" in
    ''|*[!0-9]*) fail "could not read df output for $VOLUME" ;;
    *)
      note "$VOLUME: ${DF_PCT}% used, ${DF_HUMAN:-size unknown}"
      if [ "$DF_PCT" -ge "$DISK_WARN" ]; then
        warn "$VOLUME is ${DF_PCT}% full (warn at ${DISK_WARN}%). A full volume stops the bridge writing bridge.db."
      else
        pass "$VOLUME at ${DF_PCT}%, under the ${DISK_WARN}% mark"
      fi
      ;;
  esac
fi

# ─── 8. Env drift ─────────────────────────────────────────────────────────────
check 8 "env drift (.env.example vs the NAS .env)"

if [ "$QUICK" = 1 ]; then
  skipped "--quick"
elif [ "$SSH_OK" = 0 ]; then
  fail "unverifiable: no SSH to read $NAS_PATH/.env"
elif [ ! -f "$ENV_EXAMPLE" ]; then
  fail "no $ENV_EXAMPLE to compare against"
else
  # KEY NAMES ONLY. The remote cat is piped straight into the key extractor, so
  # no variable in this script ever holds a secret value and nothing that could
  # hold one is ever printed.
  # sed, not `grep -o | tr`: [:space:] includes the newline, so tr would collapse
  # every key onto one line and make the comm diff below meaningless. The `.*`
  # after the `=` is what discards the value, and it never reaches a variable.
  key_names() { sed -nE 's/^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=.*/\1/p' | sort -u; }

  LOCAL_KEYS="$(key_names < "$ENV_EXAMPLE" || true)"
  NAS_KEYS="$($SSH "$NAS_HOST" "cat $NAS_PATH/.env 2>/dev/null || true" | key_names || true)"

  if [ -z "$NAS_KEYS" ]; then
    fail "could not read any keys from $NAS_PATH/.env on the NAS"
  else
    note "$ENV_EXAMPLE: $(printf '%s\n' "$LOCAL_KEYS" | grep -c . || true) keys"
    note "NAS .env:     $(printf '%s\n' "$NAS_KEYS" | grep -c . || true) keys"

    MISSING="$(comm -23 <(printf '%s\n' "$LOCAL_KEYS") <(printf '%s\n' "$NAS_KEYS") | tr '\n' ' ')"
    EXTRA="$(comm -13 <(printf '%s\n' "$LOCAL_KEYS") <(printf '%s\n' "$NAS_KEYS") | tr '\n' ' ')"
    MISSING="$(printf '%s' "$MISSING" | sed 's/[[:space:]]*$//')"
    EXTRA="$(printf '%s' "$EXTRA" | sed 's/[[:space:]]*$//')"

    [ -n "$MISSING" ] && note "missing on the NAS: $MISSING"
    [ -n "$EXTRA" ]   && note "on the NAS only:    $EXTRA"

    if [ -n "$MISSING" ]; then
      fail "the NAS .env is missing key(s) the app expects: $MISSING"
    elif [ -n "$EXTRA" ]; then
      warn "the NAS has key(s) .env.example does not document: $EXTRA"
    else
      pass "key names match"
    fi
  fi
fi

# ─── summary ──────────────────────────────────────────────────────────────────
say ""
say "═══ summary ═══"
printf '%s' "$RESULTS"
say ""

if [ "$FAILED" -gt 0 ]; then
  say "✗ $FAILED check(s) FAILED, $WARNED warning(s), $SKIPPED skipped. The paid-access path is not fully healthy."
  exit 1
fi

# A skipped check is not a pass. Saying "all checks passed" after skipping the
# ingress probe is how a run with no local .env, or any --quick run, gets relayed
# as "Stripe to Plex is healthy" when nothing ever asked whether Stripe can
# reach us. Nothing failed, so the exit code stays 0 and the wording carries it.
if [ "$SKIPPED" -gt 0 ]; then
  say "⚠ Nothing failed, but $SKIPPED check(s) were NOT PROBED ($WARNED warning(s))."
  say "  This is not an all-clear: the skipped checks above were never run."
  exit 0
fi

if [ "$WARNED" -gt 0 ]; then
  say "✓ All 8 checks passed, with $WARNED warning(s) worth reading above."
  exit 0
fi

say "✓ All 8 checks passed. Stripe to Plex is healthy."
