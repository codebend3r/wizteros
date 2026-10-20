#!/usr/bin/env bash
# Runs every "label=command" argument concurrently inside one CI job, then
# prints each log whole in its own group, so interleaved output never hides
# which task failed. Exits 1 if any task failed; every task always finishes.
set -uo pipefail

[ "$#" -gt 0 ] || { echo 'usage: run-parallel.sh "label=command" ...' >&2; exit 2; }

logs="$(mktemp -d)"
trap 'rm -rf "$logs"' EXIT

labels=()
pids=()
for task in "$@"; do
  label="${task%%=*}"
  command="${task#*=}"
  [ "$label" != "$task" ] || { echo "Not label=command: $task" >&2; exit 2; }
  index="${#labels[@]}"
  bash -c "$command" >"$logs/$index.log" 2>&1 &
  labels+=("$label")
  pids+=("$!")
done

summary="${GITHUB_STEP_SUMMARY:-/dev/null}"
failed=0
for index in "${!pids[@]}"; do
  label="${labels[$index]}"
  if wait "${pids[$index]}"; then
    verdict='✅ passed'
  else
    verdict='❌ failed'
    failed=1
  fi
  echo "::group::$verdict  $label"
  cat "$logs/$index.log"
  echo '::endgroup::'
  [ "$verdict" = '✅ passed' ] || echo "::error title=$label::$label failed; expand its group above for the log."
  echo "- $verdict: $label" >>"$summary"
done

exit "$failed"
