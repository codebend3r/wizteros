#!/bin/sh
# Prints the ssh target (user@ip) of one fleet host, built from the gitignored
# .env so no address or account name is ever committed.
#
#   scripts/nas-host.sh [meleys|vermithor|caraxes|syrax|vhagar]   (default meleys)
#
# Resolution, first hit wins:
#   1. the host's override: WZ_NAS_HOST for meleys, WZ_<HOST>_SSH for any host
#   2. FM_SSH_USER plus the host's position in FM_HOST_IPS, the same
#      comma-separated list the fleet monitor reads (meleys, vermithor,
#      caraxes, syrax, vhagar order)
# Values come from the environment, then from the .env at the repo root
# (WZ_ENV_FILE points at another one). Fails, naming what is missing, rather
# than guessing a target.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
env_file="${WZ_ENV_FILE:-$(dirname "$here")/.env}"
host="${1:-meleys}"

case "$host" in
  meleys) index=1 ;;
  vermithor) index=2 ;;
  caraxes) index=3 ;;
  syrax) index=4 ;;
  vhagar) index=5 ;;
  *) echo "nas-host: unknown host '$host' (meleys, vermithor, caraxes, syrax, vhagar)" >&2; exit 2 ;;
esac

# The value of a variable: the environment wins, then the last assignment in the env file.
read_var() {
  eval "value=\${$1:-}"
  if [ -z "$value" ] && [ -f "$env_file" ]; then
    value=$(sed -n "s/^$1=//p" "$env_file" | tail -1 | tr -d "\"'")
  fi
  printf '%s' "$value"
}

upper=$(printf '%s' "$host" | tr '[:lower:]' '[:upper:]')
override=$(read_var "WZ_${upper}_SSH")
[ -z "$override" ] && [ "$host" = meleys ] && override=$(read_var WZ_NAS_HOST)
if [ -n "$override" ]; then
  printf '%s\n' "$override"
  exit 0
fi

user=$(read_var FM_SSH_USER)
ips=$(read_var FM_HOST_IPS)
if [ -z "$user" ] || [ -z "$ips" ]; then
  echo "nas-host: set FM_SSH_USER and FM_HOST_IPS in $env_file (or WZ_${upper}_SSH / WZ_NAS_HOST) to reach $host" >&2
  exit 1
fi

ip=$(printf '%s' "$ips" | cut -d, -f"$index" | tr -d ' ')
if [ -z "$ip" ]; then
  echo "nas-host: FM_HOST_IPS has no entry $index for $host" >&2
  exit 1
fi
printf '%s@%s\n' "$user" "$ip"
