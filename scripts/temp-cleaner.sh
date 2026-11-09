#!/bin/bash
# Removes Ark test temp leftovers older than 12 minutes from $TMPDIR every <interval> seconds, then
# runs `git worktree prune` in the workspace so a removed folder that was a worktree leaves no dangling
# entry. bun test cleans up after itself; this covers test processes that were killed. Exits and
# prints LOW DISK when / has less than 15 GB free.
# Usage: temp-cleaner.sh <workspace> <interval seconds> [--once]
# The workspace is the project workspace. --once makes one pass and exits.
workspace=${1:?usage: temp-cleaner.sh <workspace> <interval seconds> [--once]}
interval=${2:?usage: temp-cleaner.sh <workspace> <interval seconds> [--once]}
[ -d "$workspace" ] || { echo "no such workspace: $workspace" >&2; exit 1; }
cd "${TMPDIR:?TMPDIR is not set}" || exit 1
while true; do
  find . -maxdepth 1 -type d \( -name 'ark-*' -o -name 'ark179-*' -o -name 'ark199-*' -o -name 'plannotator-data-*' -o -name '.*.bun-chrome' -o -name 'bun-test-*' \) -mmin +12 -print0 | xargs -0 rm -rf
  git -C "$workspace" worktree prune 2>/dev/null
  freeGigabytes=$(df -k / | awk 'NR==2{print int($4/1024/1024)}')
  if [ "$freeGigabytes" -lt 15 ]; then
    command -v osascript >/dev/null && osascript -e "display notification \"Only ${freeGigabytes} GB free\" with title \"Ark: low disk\"" >/dev/null 2>&1
    echo "LOW DISK: ${freeGigabytes} GB free at $(date +%H:%M)"
    break
  fi
  [ "$3" = --once ] && break
  sleep "$interval"
done
