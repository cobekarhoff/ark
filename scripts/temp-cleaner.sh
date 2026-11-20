#!/bin/bash
# Stops orphaned bun test workers (below), then removes Ark test temp leftovers from $TMPDIR every <interval> seconds, then
# runs `git worktree prune` in the workspace so a removed folder that was a worktree leaves no dangling
# entry. A folder whose <folder>/ark-owner.pid (decimal pid) names a live process is kept at any age
# (kill -0; EPERM counts as alive). Once that owner has ended the folder goes after 12 minutes. A folder
# with no, empty, non-numeric, zero, negative or unreadable owner file goes after 180 minutes.
# bun test cleans up after itself; this covers test processes that were killed. It loops until stopped.
# A bun test worker (`bun test --test-worker`) with parent pid 1 whose working folder, by real path, is inside a temp
# root of $TMPDIR is stopped with `kill <pid>` on the first pass that finds it 10 minutes or more after the pass that
# first saw it orphaned (<state dir>/temp-cleaner.orphans keeps "<pid> <epoch seconds>"). The command line of the pid
# is checked again right before the kill. No other process is stopped, and a failing ps, lsof or kill skips that row.
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
orphanFile="$stateDir/temp-cleaner.orphans"
orphanSeconds=600
root=$(pwd -P)
# The folders this script cleans, as `find` tests: the same list picks the temp root a worker runs in.
rootNames=(\( -name 'ark-*' -o -name 'ark179-*' -o -name 'ark199-*' -o -name 'plannotator-data-*' -o -name '.*.bun-chrome' -o -name 'bun-test-*' \))
# `bun test --test-worker`, with or without a path. `ark chief state` (cli/host.ts) counts the same command.
workerCommand='^([^ ]*/)?bun test --test-worker( |$)'

# True when the folder $1, by real path, is inside a temp root of $TMPDIR (compared by real path: /var is /private/var).
inTempRoot() {
  local real first
  real=$(cd "$1" 2>/dev/null && pwd -P) || return 1
  [[ $real == "$root"/* ]] || return 1
  first=${real#"$root"/}
  [ -n "$(find "$root/${first%%/*}" -maxdepth 0 -type d "${rootNames[@]}" 2>/dev/null)" ]
}

# Stops, by pid, a bun test worker whose parent is pid 1 and whose working folder is in a temp root, on the first pass
# that finds it $orphanSeconds or more after the pass that first saw it. `ps` has no "orphaned since", so the first
# sighting is kept in $orphanFile ("<pid> <epoch seconds>" per line); a pid that is no longer listed loses its line.
# A failing ps, lsof or kill skips the row and never ends the pass.
stopOrphans() {
  local listing pid parent rss command candidates=" " found cwds line rooted=" " now seen recheck current kept=""
  listing=$(ps -axww -o pid=,ppid=,rss=,command= 2>/dev/null) || return 0
  while read -r pid parent rss command; do
    [ "$parent" = 1 ] && [[ $command =~ $workerCommand ]] && candidates="$candidates$pid "
  done <<< "$listing"
  [ "$candidates" = " " ] && [ ! -e "$orphanFile" ] && return 0
  if [ "$candidates" != " " ]; then
    cwds=$(lsof -a -d cwd -Fn -p "$(echo $candidates | tr ' ' ',')" 2>/dev/null)
    while IFS= read -r line; do
      case $line in
        p*) found=${line#p} ;;
        n*) inTempRoot "${line#n}" && rooted="$rooted$found " ;;
      esac
    done <<< "$cwds"
  fi
  now=$(date +%s)
  for pid in $candidates; do
    seen=$(awk -v pid="$pid" '$1 == pid { print $2; exit }' "$orphanFile" 2>/dev/null)
    if [ -z "$seen" ]; then
      [[ $rooted == *" $pid "* ]] || continue
      seen=$now
    fi
    if [[ $rooted == *" $pid "* ]] && [ $((now - seen)) -ge "$orphanSeconds" ]; then
      # The pid may belong to another process by now: look at it once more right before the kill.
      recheck=$(ps -p "$pid" -ww -o ppid=,command= 2>/dev/null)
      read -r parent current <<< "$recheck"
      if [ "$parent" = 1 ] && [[ $current =~ $workerCommand ]] && kill "$pid" 2>/dev/null; then
        continue
      fi
    fi
    kept="$kept$pid $seen"$'\n'
  done
  printf '%s' "$kept" > "$orphanFile.tmp" && mv "$orphanFile.tmp" "$orphanFile"
}
while true; do
  stopOrphans
  find . -maxdepth 1 -type d "${rootNames[@]}" -mmin +12 -print0 |
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
