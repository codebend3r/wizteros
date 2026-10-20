#!/usr/bin/env bash
# Lints the workflows with a pinned, checksummed actionlint and the CI shell
# scripts with ShellCheck (preinstalled on GitHub's Ubuntu runners).
set -euo pipefail

version=1.7.12
sha256=8aca8db96f1b94770f1b0d72b6dddcb1ebb8123cb3712530b08cc387b349a3d8
dir="${RUNNER_TEMP:-$(mktemp -d)}"

curl --fail --silent --show-error --location --retry 3 \
  "https://github.com/rhysd/actionlint/releases/download/v$version/actionlint_${version}_linux_amd64.tar.gz" \
  --output "$dir/actionlint.tar.gz"
echo "$sha256  $dir/actionlint.tar.gz" | sha256sum --check
tar -xzf "$dir/actionlint.tar.gz" -C "$dir" actionlint
"$dir/actionlint" -color
shellcheck scripts/ci/*.sh
