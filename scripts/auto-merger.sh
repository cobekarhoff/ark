#!/bin/bash
# Auto-merger for Master Chief. Merges each open PR of an Ark run in merge_requests_open
# once GitHub reports mergeStateStatus CLEAN (CI passed on the latest head) and 3 rules hold:
# the run has retro.md (the run lead sent its final report), its ticket status is not
# superseded or done (a missing ticket file counts as live), and `ark status <run>` still
# says phase: merge_requests_open right before gh pr merge. A held PR prints one
# "HELD: <run> #<number> <reason>" line to stderr and nothing else. It also reports new
# conflicts and fully merged runs. Exits after the first pass that has a change, so Master Chief
# can close runs, sync and start tickets, then restart it.
# Usage: auto-merger.sh <workspace> <interval seconds> [known conflicting PR numbers...]
# Set ARK_PROJECT to limit it to one project. Needs ark, gh and (for the macOS notice, skipped when missing) osascript on PATH.
workspace=${1:?usage: auto-merger.sh <workspace> <interval seconds> [known conflicting PR numbers...]}
interval=${2:?usage: auto-merger.sh <workspace> <interval seconds> [known conflicting PR numbers...]}
shift 2
cd "$workspace" || exit 1
knownConflicts=" "
held=" "
for number in "$@"; do knownConflicts="$knownConflicts#$number "; done

# Prints why the PR of run $1 is held, or nothing when it may merge.
holdReason() {
  local runDir ticketId status
  runDir=$(compgen -G "${ARK_HOME:-$HOME/.ark}/projects/${ARK_PROJECT:-*}/runs/$1" | head -n 1)
  [ -f "$runDir/retro.md" ] || { echo "no final report"; return; }
  ticketId=$(sed -n 's/^id: *//p' "$runDir/ticket.md" 2>/dev/null | head -n 1)
  [ -n "$ticketId" ] || return
  status=$(sed -n 's/^status: *//p' "$runDir/../../tickets/$ticketId.md" 2>/dev/null | head -n 1)
  case $status in superseded | done) echo "ticket $status" ;; esac
}

notify() {
  command -v osascript >/dev/null && osascript -e "display notification \"$1\" with title \"Ark auto-merger\"" >/dev/null 2>&1
}

while true; do
  changes=""
  for runName in $(ark status ${ARK_PROJECT:+--project "$ARK_PROJECT"} | awk '$2=="merge_requests_open"{print $1}'); do
    statusLines=$(ark merge-request status ${ARK_PROJECT:+--project "$ARK_PROJECT"} "$runName")
    for url in $(echo "$statusLines" | awk '$2=="open"{print $3}'); do
      number=${url##*/}
      mergeState=$(gh pr view "$url" --json mergeStateStatus -q .mergeStateStatus)
      if [ "$mergeState" = CLEAN ]; then
        reason=$(holdReason "$runName")
        if [ -n "$reason" ]; then
          [[ "$held" != *" #$number "* ]] && { echo "HELD: $runName #$number $reason" >&2; held="$held#$number "; }
          continue
        fi
        ark status ${ARK_PROJECT:+--project "$ARK_PROJECT"} "$runName" | grep -q 'phase: merge_requests_open' || continue
        if gh pr merge "$url" --merge >/dev/null 2>&1; then
          changes="$changes $runName #$number merged;"
          notify "Merged PR #$number ($runName)"
        else
          changes="$changes $runName #$number merge failed;"
          notify "Merge failed: PR #$number ($runName)"
        fi
      elif [ "$mergeState" = DIRTY ] && [[ "$knownConflicts" != *" #$number "* ]]; then
        changes="$changes $runName #$number conflicting;"
        notify "Conflict: PR #$number ($runName)"
      fi
    done
    echo "$statusLines" | grep -q ' merged ' && ! echo "$statusLines" | grep -q ' open ' && changes="$changes $runName all merged;"
  done
  [ -n "$changes" ] && { echo "CHANGE:$changes"; break; }
  sleep "$interval"
done
