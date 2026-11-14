#!/bin/bash
# Keeps the project folder $ARK_HOME/projects/$ARK_PROJECT (default ARK_HOME: ~/.ark) in its own git repository and
# commits every change in it every <interval> seconds, so a file that a script or an agent emptied can be restored.
# When the folder has no .git of its own it runs `git init` there, never in a parent repository: every git call
# names the folder's own .git. When the folder has no .gitignore it writes one for runs/, services/, test-cache/,
# qe/, audit/ and prototypes/; an existing .gitignore is left alone. A pass runs `git add -A` and commits only when
# `git status --porcelain` is not empty, with the message "autocommit: <count> changed files". The commit sets
# its own identity and turns off signing and hooks, so launchd (no global identity) cannot make it fail. It never
# pushes, and it never deletes an index.lock: a failed commit (a held lock, for example) is written to stderr, which
# launchd keeps in services/project-autocommit.log, and the next pass tries again.
# Usage: project-autocommit.sh <workspace> <interval seconds> [--once]
# The workspace is the project workspace; the script does not use it. --once makes one pass and exits 1 when the
# commit failed. Exits 1 at once when ARK_PROJECT is empty, unset or not a plain folder name, or has no folder.
workspace=${1:?usage: project-autocommit.sh <workspace> <interval seconds> [--once]}
interval=${2:?usage: project-autocommit.sh <workspace> <interval seconds> [--once]}
case ${ARK_PROJECT:-} in
  "" | . | .. | */*) echo "ARK_PROJECT is empty, not set or not a project name: '${ARK_PROJECT:-}'" >&2; exit 1 ;;
esac
project="${ARK_HOME:-$HOME/.ark}/projects/$ARK_PROJECT"
[ -d "$project" ] || { echo "no such project folder: $project" >&2; exit 1; }

projectGit() { git --git-dir="$project/.git" --work-tree="$project" "$@"; }

commitPass() {
  [ -e "$project/.git" ] || git init -q --initial-branch=main "$project" || return 1
  [ -e "$project/.gitignore" ] ||
    printf '%s\n' runs/ services/ test-cache/ qe/ audit/ prototypes/ > "$project/.gitignore" || return 1
  projectGit add -A || return 1
  [ -n "$(projectGit status --porcelain)" ] || return 0
  local changedFileCount
  changedFileCount=$(projectGit diff --cached --name-only | wc -l | tr -d ' ')
  projectGit -c user.name="Ark autocommit" -c user.email="autocommit@ark.invalid" -c commit.gpgsign=false \
    -c core.hooksPath=/dev/null commit -q -m "autocommit: $changedFileCount changed files"
}

while true; do
  if ! commitPass; then
    echo "autocommit failed at $(date +%H:%M:%S) in $project, will retry on the next pass" >&2
    [ "${3:-}" = --once ] && exit 1
  fi
  [ "${3:-}" = --once ] && break
  sleep "$interval"
done
