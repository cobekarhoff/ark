---
id: ARK-T151
title: ARK-T151 gather.ts refuses a directory that is not a worktree of the run and names it
level: integration
technique: equivalence classes (directory in the run / directory outside the run) with one boundary: a git repo on the same branch name that is not a run worktree
priority: medium
risk: with no path match, gather falls back to the first repo on the branch (or the first repo) and writes that repo's ledger into a foreign directory, so a wrong MR could be posted from it, or it exits non-zero without naming the directory
status: active
changed_by: 2026-11-09-ARK-362-1
---

## Objective

Prove that `gather.ts --run-dir <run folder>` exits non-zero and names the current directory when that directory is not a worktree of the run.

## Preconditions

- The 2-repo run fixture of ARK-T150.
- A third git repo, outside the run, with the same branch name checked out and an origin.
- A plain non-git temp directory.

## Steps

1. Run `gather.ts --run-dir <run folder>` with cwd = the third repo.
2. Run it again with cwd = the non-git directory.
3. Read the exit code, stderr and stdout of each run.
4. List `.pr-writing/` in the third repo.

## Expected results

- When cwd is not a worktree of the run, the system shall exit non-zero and the message shall contain the absolute path of that directory.
- The third repo shall have no `.pr-writing/ledger.json` after the run.
- The same holds for the non-git directory: non-zero exit, directory named, no file written.

## Screenshot checkpoints

none: cli_output case; the observable is exit code and message text.
