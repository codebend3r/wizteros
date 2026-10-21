#!/usr/bin/env bash
# Keeps CI passing whatever state Nx Cloud is in. The Hobby plan has no usage
# API: once the month's credits are spent, Nx Cloud answers 401 "disabled due
# to exceeding the FREE plan", which can mark passing tasks failed.
#
#   probe         one small cloud-backed task before the checks; exports
#                 NX_NO_CLOUD=true to every later step unless Nx Cloud took
#                 the run cleanly
#   run CMD...    runs an Nx command; if Nx Cloud was on and the command
#                 failed with Nx Cloud trouble in its log, runs it once more
#                 without Nx Cloud, so only a real task failure fails the job
set -uo pipefail

env_file="${GITHUB_ENV:-/dev/null}"
summary="${GITHUB_STEP_SUMMARY:-/dev/null}"

# Nx exits 0 on most Nx Cloud errors and only says so in its output.
trouble='Nx Cloud (encountered some problems|was not used|wasn.t able)|exceed(ed|ing) the [a-z]+ plan|organization has been disabled|Invalid Credentials|code: 40[13]'

usage() {
  echo 'usage: nx-cloud.sh probe | nx-cloud.sh run <command> [args...]' >&2
  exit 2
}

choose() {
  echo "NX_NO_CLOUD=$1" >>"$env_file"
  echo "- ☁️ $2" >>"$summary"
  exit 0
}

probe() {
  # Fork PRs never receive secrets, and a clone without the secret has no cloud.
  if [ -z "${NX_CLOUD_ACCESS_TOKEN:-}" ]; then
    echo '::notice title=Nx Cloud off::No NX_CLOUD_ACCESS_TOKEN in this run; using the local Nx cache only.'
    choose true 'Nx Cloud off: no access token in this run'
  fi

  local log status
  local limit=()
  # GitHub's runners have coreutils timeout; a hung Nx Cloud must not stall the job.
  if command -v timeout >/dev/null; then limit=(timeout 180); fi
  log="$(mktemp)"

  # Runs before the local cache is restored, so the task has to ask the remote
  # cache and Nx Cloud has to accept the run.
  NX_NO_CLOUD=false ${limit[@]+"${limit[@]}"} bunx nx run @wizteros/server-common:format:check --outputStyle=static >"$log" 2>&1
  status=$?

  echo '::group::Nx Cloud probe'
  cat "$log"
  echo '::endgroup::'

  if grep -qiE "$trouble" "$log"; then
    rm -f "$log"
    echo '::warning title=Nx Cloud off::Nx Cloud refused or failed the probe (monthly credits used up, a bad token, or an outage); running without it.'
    choose true 'Nx Cloud off: it refused or failed the probe'
  fi
  rm -f "$log"
  if [ "$status" -ne 0 ]; then
    echo "::warning title=Nx Cloud off::The Nx Cloud probe exited $status; running without Nx Cloud so the checks still report."
    choose true "Nx Cloud off: the probe exited $status"
  fi
  choose false 'Nx Cloud on: remote cache in use'
}

run() {
  local log status
  log="$(mktemp)"
  "$@" 2>&1 | tee "$log"
  status="${PIPESTATUS[0]}"

  # Tasks that passed are in the local cache, so the rerun repeats only the
  # failed ones, and a genuine failure fails again.
  if [ "$status" -ne 0 ] && [ "${NX_NO_CLOUD:-}" != true ] && grep -qiE "$trouble" "$log"; then
    echo '::warning title=Nx Cloud dropped::Nx Cloud failed during the run; rerunning the failed tasks without it.'
    echo '- ☁️ Nx Cloud failed mid-run; reran without it' >>"$summary"
    NX_NO_CLOUD=true "$@"
    status=$?
  fi
  rm -f "$log"
  return "$status"
}

case "${1:-}" in
  probe) probe ;;
  run)
    shift
    [ "$#" -gt 0 ] || usage
    run "$@"
    ;;
  *) usage ;;
esac
