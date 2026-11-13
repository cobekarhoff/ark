#!/bin/bash
# Idle sweep for one project. Every <interval> seconds it
# 1. closes (orca terminal close) the terminal of each settled dispatch (state succeeded, failed or stopped) of the
#    project's Runs "Ark run <run>" whose run folder is under $ARK_HOME/projects/<project>/runs, when that terminal is
#    still in `orca terminal list` and connected. The dispatch state is read again from a fresh worker-list right
#    before each close; a terminal that a live dispatch of any Run uses is never closed (every Run is read again). Retained and release_unknown terminals
#    (kept open on purpose) are left. Master Chief's Run, run leads and other projects are never selected: only Runs
#    "Ark run <run>" of this project are read.
# 2. lists connected terminals under that runs folder or the project workspace with no output for more than one day (an agent or prototype
#    server). It only lists them; it never stops them.
# It sends one status message "Sweep: closed <n>, idle <m>" to the Run "Master Chief: <project> tickets"
# (scripts/mc-send.sh) when it closed something or the idle list changed. An unsent message is kept in
# <state dir>/sweep.pending and retried next pass. Needs ARK_PROJECT, orca and jq; without them it says so and exits 0.
# Usage: sweep.sh <workspace> <interval seconds> [--once]
workspace=${1:?usage: sweep.sh <workspace> <interval seconds> [--once]}
interval=${2:?usage: sweep.sh <workspace> <interval seconds> [--once]}
once=
[ "$3" = --once ] && once=1
project=${ARK_PROJECT:-}
[ -n "$project" ] || { echo "sweep: ARK_PROJECT is not set, nothing to do" >&2; exit 0; }
command -v orca >/dev/null && command -v jq >/dev/null || { echo "sweep: orca or jq not on PATH, nothing to do" >&2; exit 0; }
source "$(dirname "${BASH_SOURCE[0]}")/mc-send.sh"
runsRoot="${ARK_HOME:-$HOME/.ark}/projects/$project/runs"
pending="$stateDir/sweep.pending"
idleState="$stateDir/sweep.idle"
settled='["succeeded","failed","stopped"]'

# liveOwner <terminal> <run ids>: fails when a dispatch of any Run that is not settled uses the terminal (a terminal can be
# reused by worker-start --terminal across Runs), or when a Run's dispatches cannot be read: then nothing is closed.
liveOwner() {
  local t=$1 runId rows
  for runId in $2; do
    rows=$(orcaRows workers orchestration worker-list --run "$runId" </dev/null) || return 1
    [ -z "$(jq -r --arg t "$t" --argjson settled "$settled" 'select(.terminal == $t) | select(.state | IN($settled[]) | not) | .dispatchId' <<<"$rows")" ] || return 1
  done
}

pass() {
  local allRunIds runs terminals connected id name rows candidates dispatch terminal fresh idle idleSignature body count
  runs=$(orcaRows runs orchestration run-list --full) || { echo "sweep: orca run-list failed, retry next pass" >&2; return; }
  allRunIds=$(jq -r '.id' <<<"$runs")
  terminals=$(orca terminal list --limit 1000 --json) || { echo "sweep: orca terminal list failed, retry next pass" >&2; return; }
  connected=$(jq -c '[.result.terminals[]? | select(.connected) | .handle]' <<<"$terminals") || return
  while IFS=$'\t' read -r id name; do
    [ -d "$runsRoot/${name#Ark run }" ] || continue
    rows=$(orcaRows workers orchestration worker-list --run "$id" </dev/null) || { echo "sweep: worker-list of $name failed" >&2; continue; }
    candidates=$(jq -r --argjson live "$connected" --argjson settled "$settled" \
      'select(.state | IN($settled[])) | select(.terminalState | IN("retained", "release_unknown") | not) | select(.terminal as $t | $live | index($t)) | [.dispatchId, .terminal] | @tsv' <<<"$rows")
    while IFS=$'\t' read -r dispatch terminal; do
      [ -n "$dispatch" ] || continue
      fresh=$(orcaRows workers orchestration worker-list --run "$id" </dev/null) || continue
      # Close only when the dispatch is still settled and no dispatch on this terminal is live.
      [ "$(jq -r --arg d "$dispatch" --argjson settled "$settled" 'select(.dispatchId == $d) | select(.state | IN($settled[])) | .dispatchId' <<<"$fresh")" = "$dispatch" ] || continue
      liveOwner "$terminal" "$allRunIds" || { echo "sweep: $terminal is used by a live dispatch or its owners cannot be read, not closed" >&2; continue; }
      if orca terminal close --terminal "$terminal" --json </dev/null >/dev/null 2>&1; then
        echo "closed $terminal ($dispatch)" >> "$pending"
        connected=$(jq -c --arg t "$terminal" 'map(select(. != $t))' <<<"$connected")
      else
        echo "sweep: closing $terminal ($dispatch) failed" >&2
      fi
    done <<<"$candidates"
  done < <(jq -r 'select(.objective // "" | startswith("Ark run ")) | [.id, .objective] | @tsv' <<<"$runs")

  idle=$(jq -r --arg root "$runsRoot/" --arg ws "${workspace%/}" --argjson live "$connected" \
    '.result.terminals[]? | select(.worktreePath // "" | . as $p | startswith($root) or $p == $ws or ($ws != "" and ($p | startswith($ws + "/")))) | select(.handle as $h | $live | index($h)) | select(.lastOutputAt < (now * 1000 - 86400000)) | [.handle, (.title // "" | .[0:60]), (.lastOutputAt / 1000 | floor | todate)] | @tsv' <<<"$terminals")
  idleSignature=$(cut -f1 <<<"$idle" | sort | tr '\n' ' ')
  if [ -s "$pending" ] || { [ -n "$idle" ] && [ "$idleSignature" != "$(cat "$idleState" 2>/dev/null)" ]; }; then
    count=$(grep -c . "$pending" 2>/dev/null)
    body="$(cat "$pending" 2>/dev/null)"$'\n'
    [ -n "$idle" ] && body="${body}idle for more than a day (left running):"$'\n'"$(awk -F'\t' '{print $1 " " $2 " last output " $3}' <<<"$idle")"
    mcSend "$project" "Sweep: closed ${count:-0}, idle $(grep -c . <<<"$idle")" "$body" </dev/null >&2
    [ $? -eq 1 ] || { : > "$pending"; printf %s "$idleSignature" > "$idleState"; }
  elif [ -z "$idle" ]; then
    : > "$idleState"
  fi
}

while true; do
  pass
  [ -n "$once" ] && break
  sleep "$interval"
done
