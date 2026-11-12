#!/bin/bash
# Sourced by auto-merger.sh, temp-cleaner.sh and sweep.sh. Not run on its own.
# mcSend <project> <subject> [body] sends one Orca status message to the Run "Master Chief: <project> tickets".
# Returns 0 sent; 2 not sent for good (no project, or no such Run: the notice goes to stderr, the log);
# 1 not sent but worth a retry on the next pass (orca or jq missing, orca not answering).
# stateDir is the folder where a service keeps what it already sent, so a launchd restart repeats nothing.

stateDir=${ARK_STATE_DIR:-${ARK_HOME:-$HOME/.ark}/projects/${ARK_PROJECT:-all}/services}
mkdir -p "$stateDir"

# orcaRows <key> <orca args...>: every row of .result.<key> over all pages, one JSON row per line.
orcaRows() {
  local key=$1 page cursor=""
  shift
  while :; do
    page=$(orca "$@" --json --limit 100 ${cursor:+--cursor "$cursor"}) || return 1
    jq -c --arg key "$key" '.result[$key][]?' <<<"$page" || return 1
    cursor=$(jq -r '.result.nextCursor // empty' <<<"$page") || return 1
    [ -n "$cursor" ] || return 0
  done
}

mcSend() {
  local project=$1 subject=$2 body=${3:-} runs id
  [ -n "$project" ] || { echo "no ARK_PROJECT, not sent: $subject" >&2; return 2; }
  command -v orca >/dev/null && command -v jq >/dev/null || { echo "orca or jq not on PATH, will retry: $subject" >&2; return 1; }
  runs=$(orcaRows runs orchestration run-list --full) || { echo "orca run-list failed, will retry: $subject" >&2; return 1; }
  id=$(jq -r --arg objective "Master Chief: $project tickets" 'select(.objective == $objective) | .id' <<<"$runs" | head -n 1)
  [ -n "$id" ] || { echo "no Orca Run \"Master Chief: $project tickets\", not sent: $subject" >&2; return 2; }
  orca orchestration send --to "run:$id" --type status --subject "$subject" ${body:+--body "$body"} >/dev/null ||
    { echo "orca send failed, will retry: $subject" >&2; return 1; }
}
