#!/usr/bin/env bash
# Syncs desktop/ and supportdesk/ from WSL to a Windows folder, where Windows Node runs Electron,
# the e2e tests and the installer build. node_modules is never shared between Linux and Windows.
#
#   desktop/tools/sync-windows.sh            (default target: /mnt/c/Users/<you>/bugdetective-dev)
#   BUGDETECTIVE_WIN_DEV=/mnt/c/dev/bd desktop/tools/sync-windows.sh
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
root=$(cd "$here/.." && pwd)
win_user=$(cd /mnt/c && cmd.exe /d /c "echo %USERNAME%" 2>/dev/null | tr -d '\r')
target=${BUGDETECTIVE_WIN_DEV:-/mnt/c/Users/$win_user/bugdetective-dev}
mkdir -p "$target"

rsync -a --delete \
  --exclude node_modules --exclude out --exclude dist --exclude build \
  --exclude test-results --exclude playwright-report \
  "$root/desktop/" "$target/desktop/"

# The whole repository, including .git (LocalContentSource reads the stage branches).
rsync -a --delete \
  --exclude node_modules --exclude 'qa/.package-*' --exclude 'server/data/*.db*' \
  "$root/supportdesk/" "$target/supportdesk/"

echo "Synced to $target"
