---
id: ARK-T18
title: ARK-T18 worktree sync refuses an id the target already holds
level: integration
technique: equivalence classes (id taken with other content, taken with same content, untouched by the run, new) and state transition (before and after the merge)
priority: high
risk: sync merges a branch whose new test case ids collide with ids another run already merged, failing with a generic add/add conflict that names no id, or refuses ids that are identical or untouched
status: active
changed_by: 2026-11-06-ARK-319-1
---

## Objective

Prove that `ark worktree sync <run>` refuses, before it merges, a run branch that adds a `test/cases/<id>.md` whose id the target branch holds with different content, names each such id, and leaves the worktree unchanged. Serves ARK-319/AC3.

Expected: When the run branch adds a test case id that the target branch holds with other content, the system shall refuse the sync and name the id.

## Preconditions

- A temporary `ARK_HOME` with project `demo` whose workspace repo has a bare origin (origin/HEAD names main). main holds `test/cases/ARK-T3.md`.
- A run with an approved plan and a worktree created from main.
- The run branch commits `ARK-T5.md` ("run five"), `ARK-T6.md` ("run six"), `ARK-T7.md` ("run seven") and `ARK-T8.md` ("same eight").
- Another run then merged to origin/main: `ARK-T5.md` ("main five"), `ARK-T6.md` ("main six"), `ARK-T8.md` ("same eight", identical to the run's) and an edit of `ARK-T3.md`.

## Steps

1. Record the worktree's `HEAD`.
2. Run `ark worktree sync <run>`.
3. Read the exit code and stderr; read the worktree's `HEAD` and `git status`.

## Expected results

- The exit code is 1.
- stderr holds `test case id taken on the target branch: ARK-T5` and `test case id taken on the target branch: ARK-T6`.
- stderr does not name `ARK-T3` (edited on main, not touched by the run), `ARK-T7` (not on main) or `ARK-T8` (same content on both sides).
- The worktree's `HEAD` equals the recorded one and `git status --porcelain` is empty: the refusal came before the merge.

## Screenshot checkpoints

None, CLI output. The surface is the error text on stderr; no screen applies.
