---
id: ARK-T248
title: ARK-T248 merge-request open refuses to refresh an open merge request whose branch conflicts with the fetched target, pushes nothing, and allows --merge
level: integration
technique: state transition (open MR, target moves on) with the pushed ref as the observable
priority: high
risk: a second `ark merge-request open` refreshes an open MR and pushes a branch that conflicts with origin's target, because the mergeability check covers only repos that need a new MR
status: active
changed_by: 2026-11-11-ARK-407-1
---

## Objective

Prove that `ark merge-request open` checks a repo whose MR is open with `git fetch` and `git merge-tree` before it pushes, and refuses when the head does not merge cleanly.

## Preconditions

- Real git, a temp bare `origin` for each repo, fake `gh` on PATH.
- A run whose MRs are open, pushed from a branch that edits `README.md`.
- origin's target then changes the same line of `README.md`, and the run has a new tested head.

## Steps

1. Run `ark merge-request open <run>` again.
2. Read the exit code, the message, the origin ref of the run branch and the run events.

## Expected results

- When an open merge request branch does not merge cleanly into the target, the system shall refuse to push it: exit non-zero, the message names the repo, says the head does not merge cleanly and names `--merge`.
- The origin ref of the run branch shall not move, and no MR body is edited.
- The system shall record `worktree.synced` with `conflict: true`, so a step started with `--merge` is allowed.

## Screenshot checkpoints

none: CLI integration case; the observables are exit codes, messages and the origin ref.
