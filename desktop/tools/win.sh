#!/usr/bin/env bash
# Runs a command in the synced Windows copy of desktop/ with the Windows Node.js 26 toolchain.
#
#   desktop/tools/win.sh npm ci
#   desktop/tools/win.sh npm run test:e2e
#
# BUGDETECTIVE_WIN_NODE points at a Windows folder with node.exe (default: the portable Node.js
# in %USERPROFILE%\bugdetective-dev\tools\node-v<.nvmrc>-win-x64). Extra environment variables
# for the Windows side can be passed as BD_WIN_ENV="NAME=value NAME2=value".
set -euo pipefail

here=$(cd "$(dirname "$0")/.." && pwd)
version=$(cat "$here/.nvmrc")
cd /mnt/c
win_user=$(cmd.exe /d /c "echo %USERNAME%" 2>/dev/null | tr -d '\r')
dev_wsl="/mnt/c/Users/$win_user/bugdetective-dev"
dev="C:\\Users\\$win_user\\bugdetective-dev"
node_dir=${BUGDETECTIVE_WIN_NODE:-"$dev\\tools\\node-v$version-win-x64"}

# WSL interop re-quotes arguments in a way cmd.exe does not parse, so the command goes through a
# batch file. It is built from this script's own arguments (a developer tool, not app code).
script="run-$$.cmd"
{
  echo '@echo off'
  echo "cd /d \"$dev\\desktop\""
  echo "set \"PATH=$node_dir;%PATH%\""
  # npm runs scripts through %ComSpec%, which is not always set when started from WSL.
  echo 'set "ComSpec=%SystemRoot%\System32\cmd.exe"'
  for assignment in ${BD_WIN_ENV:-}; do
    echo "set \"$assignment\""
  done
  echo "$*"
} | sed 's/$/\r/' > "$dev_wsl/$script"
trap 'rm -f "$dev_wsl/$script"' EXIT
cmd.exe /d /c "$dev\\$script"
