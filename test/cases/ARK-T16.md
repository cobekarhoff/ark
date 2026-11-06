---
id: ARK-T16
title: ARK-T16 parallel test-case new in two worktrees gives unique ids
level: integration
technique: concurrency (parallel callers) and state transition (counter after each call)
priority: high
risk: two worktrees of one repo, each on its own branch, read only their own test/cases/ and print the same id, so two parallel runs write colliding cases and one must renumber by hand
status: active
changed_by: 2026-11-06-ARK-319-1
---

## Objective

Prove that `ark test-case new ARK` never prints the same id twice across the worktrees of one repo, even when each worktree holds none of the other's entries. Serves ARK-319/AC1.

Expected: When ark test-case new runs in several worktrees of one repo, the system shall print a different id for each call.

## Preconditions

- One git repo with a bare origin (origin/HEAD names main) and no id counter yet.
- Two worktrees of it, `run-a` and `run-b`, on two branches created from the same commit. Neither holds entries the other writes.

## Steps

1. Run `ark test-case new ARK` four times at once in `run-a` and four times at once in `run-b`, all eight processes in parallel.
2. Collect the eight printed ids.
3. Run `ark test-case new ARK` once more in `run-a`, then once in `run-b`.

## Expected results

- All eight commands exit 0 and print eight different ids.
- The two later calls each print an id that differs from the eight earlier ids and from each other: ten different ids in total.

## Screenshot checkpoints

None, CLI output. The surface is the id printed on stdout; no screen applies.
