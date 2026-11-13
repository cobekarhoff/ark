#!/bin/bash
# Removes Ark test temp leftovers from $TMPDIR every <interval> seconds, then
# runs `git worktree prune` in the workspace so a removed folder that was a worktree leaves no dangling
# entry. A folder whose <folder>/ark-owner.pid (decimal pid) names a live process is kept at any age
# (kill -0; EPERM counts as alive). Once that owner has ended the folder goes after 12 minutes. A folder
# with no, empty, non-numeric, zero, negative or unreadable owner file goes after 180 minutes.
# bun test cleans up after itself; this covers test processes that were killed. It loops until stopped.
# When / has less than 15 GB free it prints LOW DISK and sends one status message "Disk low: <n> GB free" to the Run
# "Master Chief: <project> tickets" (scripts/mc-send.sh), once per drop: it sends again only after free disk went above
# 15 GB and fell below it again (exactly 15 does not re-arm). <state dir>/temp-cleaner.low keeps that across a restart.
# A message that cannot be sent is retried next pass.
# Usage: temp-cleaner.sh <workspace> <interval seconds> [--once]
# The workspace is the project workspace. --once makes one pass and exits. Needs jq and orca on PATH for the message.
workspace=${1:?usage: temp-cleaner.sh <workspace> <interval seconds> [--once]}
interval=${2:?usage: temp-cleaner.sh <workspace> <interval seconds> [--once]}
[ -d "$workspace" ] || { echo "no such workspace: $workspace" >&2; exit 1; }
cd "${TMPDIR:?TMPDIR is not set}" || exit 1
source "$(dirname "${BASH_SOURCE[0]}")/mc-send.sh"
lowFlag="$stateDir/temp-cleaner.low"
diskLimit=15
while true; do
  find . -maxdepth 1 -type d \( -name 'ark-*' -o -name 'ark179-*' -o -name 'ark199-*' -o -name 'plannotator-data-*' -o -name '.*.bun-chrome' -o -name 'bun-test-*' \) -mmin +12 -print0 |
    while IFS= read -r -d '' folder; do
      limit=180
      pid=
      { read -r pid < "$folder/ark-owner.pid"; } 2>/dev/null
      if [[ $pid =~ ^[0-9]{1,9}$ ]] && [ $((10#$pid)) -gt 0 ]; then
        limit=12
        failure=$(kill -0 "$pid" 2>&1) && continue
        [[ $failure == *"not permitted"* ]] && continue
      fi
      [ "$limit" -eq 12 ] || [ -n "$(find "$folder" -maxdepth 0 -mmin +180)" ] && rm -rf "$folder"
    done
  git -C "$workspace" worktree prune 2>/dev/null
  freeGigabytes=$(df -k / | awk 'NR==2{print int($4/1024/1024)}')
  if [ "$freeGigabytes" -lt "$diskLimit" ]; then
    if [ ! -e "$lowFlag" ]; then
      command -v osascript >/dev/null && osascript -e "display notification \"Only ${freeGigabytes} GB free\" with title \"Ark: low disk\"" >/dev/null 2>&1
      echo "LOW DISK: ${freeGigabytes} GB free at $(date +%H:%M)"
      mcSend "${ARK_PROJECT:-}" "Disk low: ${freeGigabytes} GB free" </dev/null >&2
      [ $? -eq 1 ] || : > "$lowFlag"
    fi
  elif [ "$freeGigabytes" -gt "$diskLimit" ]; then
    rm -f "$lowFlag"
  fi
  [ "$3" = --once ] && break
  sleep "$interval"
done
