#!/bin/bash
# Auto-merger. Merges each open PR of an Ark run in merge_requests_open
# once GitHub reports mergeStateStatus CLEAN (CI passed on the latest head) and 3 rules hold:
# the run has retro.md (the run lead sent its final report), its ticket status is not
# superseded or done (a missing ticket file counts as live), and `ark status <run>` still
# says phase: merge_requests_open right before gh pr merge. A held PR prints one
# "HELD: <run> #<number> <reason>" line to stderr and nothing else.
# It loops until stopped. After a merge it sends one status message "Merged: <run> !<number>" to the Run
# "Master Chief: <project> tickets" (scripts/mc-send.sh); a message that cannot be sent is kept in
# <state dir>/auto-merger.pending and retried each pass. A new conflict, a failed merge and a fully merged
# run are printed once as a "CHANGE:" line (the log), not sent. <state dir>/auto-merger.seen remembers them across a restart.
# Usage: auto-merger.sh <workspace> <interval seconds> [--once] [known conflicting PR numbers...]
# --once makes one pass and exits. Set ARK_PROJECT to limit it to one project. Needs ark, gh and jq, and
# orca for the message, on PATH. A missing ark or gh is a config fault: it says so and exits 0.
workspace=${1:?usage: auto-merger.sh <workspace> <interval seconds> [--once] [known conflicting PR numbers...]}
interval=${2:?usage: auto-merger.sh <workspace> <interval seconds> [--once] [known conflicting PR numbers...]}
shift 2
cd "$workspace" || exit 1
command -v ark >/dev/null && command -v gh >/dev/null || { echo "auto-merger: ark or gh not on PATH, nothing to do" >&2; exit 0; }
source "$(dirname "${BASH_SOURCE[0]}")/mc-send.sh"
pending="$stateDir/auto-merger.pending"
seen="$stateDir/auto-merger.seen"
knownConflicts=" "
held=" "
once=
for argument in "$@"; do
  if [ "$argument" = --once ]; then once=1; else knownConflicts="$knownConflicts#$argument "; fi
done

wasSeen() { grep -qxF -- "$1" "$seen" 2>/dev/null; }
remember() { echo "$1" >> "$seen"; }

# Sends each pending message; the ones that failed stay for the next pass.
flushPending() {
  local subject rest=""
  [ -s "$pending" ] || return 0
  while IFS= read -r subject; do
    mcSend "${ARK_PROJECT:-}" "$subject" </dev/null >&2
    [ $? -eq 1 ] && rest="$rest$subject"$'\n'
  done < "$pending"
  printf %s "$rest" > "$pending"
}

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
        wasSeen "merged $runName !$number" && continue
        if gh pr merge "$url" --merge >/dev/null 2>&1; then
          remember "merged $runName !$number"
          echo "Merged: $runName !$number" >> "$pending"
          changes="$changes $runName #$number merged;"
          notify "Merged PR #$number ($runName)"
        elif ! wasSeen "merge failed $runName #$number"; then
          remember "merge failed $runName #$number"
          changes="$changes $runName #$number merge failed;"
          notify "Merge failed: PR #$number ($runName)"
        fi
      elif [ "$mergeState" = DIRTY ] && [[ "$knownConflicts" != *" #$number "* ]] && ! wasSeen "conflicting $runName #$number"; then
        remember "conflicting $runName #$number"
        changes="$changes $runName #$number conflicting;"
        notify "Conflict: PR #$number ($runName)"
      fi
    done
    if echo "$statusLines" | grep -q ' merged ' && ! echo "$statusLines" | grep -q ' open ' && ! wasSeen "all merged $runName"; then
      remember "all merged $runName"
      changes="$changes $runName all merged;"
    fi
  done
  [ -n "$changes" ] && echo "CHANGE:$changes"
  flushPending
  [ -n "$once" ] && break
  sleep "$interval"
done
