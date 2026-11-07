#!/bin/bash
# Installs sab_complete_cleanup.py on Vermithor, or with --check reports whether
# the installed copy matches this repo's. The destination is the scripts/ folder
# of the compose project the sabnzbd container runs in, read from its labels.
#
#   .claude/skills/sab-complete-cleanup/scripts/install.sh [--check]
#
# Vermithor's docker needs sudo with a password, read from WZ_NAS_PASSWORD_vermithor
# or the login keychain (service synology-nas), the same as update-arr-stack.sh.
set -eu

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../../.." && pwd)
script="$here/sab_complete_cleanup.py"
mode=install
case "${1:-}" in
  "") ;;
  --check) mode=check ;;
  *) echo "usage: install.sh [--check]" >&2; exit 2 ;;
esac

target=$("$repo/scripts/nas-host.sh" vermithor)
password="${WZ_NAS_PASSWORD_vermithor:-}"
[ -n "$password" ] || password=$(security find-generic-password -s synology-nas -a vermithor -w 2>/dev/null || true)
[ -n "$password" ] || { echo "no sudo password for vermithor. Run: nas setpw vermithor" >&2; exit 1; }

want=$(shasum -a 256 "$script" | cut -d' ' -f1)
payload=$(base64 < "$script" | tr -d '\n')

# Runs as root on Vermithor. sudo -S takes the password from stdin, so the
# snippet travels base64-encoded in the command line instead.
snippet=$(cat <<EOF
set -eu
dir=\$(/usr/local/bin/docker ps --filter label=com.docker.compose.service=sabnzbd --format '{{.Label "com.docker.compose.project.working_dir"}}')
[ -n "\$dir" ] || { echo "no running sabnzbd container on vermithor" >&2; exit 1; }
dest="\$dir/scripts/sab_complete_cleanup.py"
have=\$(sha256sum "\$dest" 2>/dev/null | cut -d' ' -f1 || true)
[ ! -e "\$dir/scripts/sab-complete-cleanup.py" ] || echo "note: the old \$dir/scripts/sab-complete-cleanup.py is still there"
if [ "$mode" = check ]; then
  [ "\$have" = "$want" ] && { echo "current: \$dest"; exit 0; }
  echo "differs from the repo: \$dest"; exit 1
fi
mkdir -p "\$dir/scripts"
echo "$payload" | base64 -d > "\$dest.tmp"
chmod 755 "\$dest.tmp"
mv "\$dest.tmp" "\$dest"
echo "installed: \$dest"
echo "task command: /usr/bin/python3 \$dest --apply"
EOF
)
encoded=$(printf '%s' "$snippet" | base64 | tr -d '\n')

printf '%s\n' "$password" | ssh -o BatchMode=yes -o ConnectTimeout=10 "$target" \
  "f=\$(mktemp); echo $encoded | base64 -d >\$f; sudo -S -p '' bash \$f; rc=\$?; rm -f \$f; exit \$rc"
