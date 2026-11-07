---
id: ARK-T33
title: ARK-T33 parallel test-case new in two worktrees gives unique ids
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

Command: `bun test test/test-case.test.ts`

1. Run `ark test-case new ARK` four times at once in `run-a` and four times at once in `run-b`, all eight processes in parallel.
2. Collect the eight printed ids.
3. Run `ark test-case new ARK` once more in `run-a`, then once in `run-b`.
4. Write `test/cases/ARK-T30.md` in `run-a` (not committed), then run `ark test-case new ARK` in `run-a`.
5. Commit `test/cases/ARK-T30.md` to origin/main, fetch it, then run `ark test-case new ARK` in `run-b`.

## Expected results

- All eight commands exit 0 and print the eight ids `ARK-T1` to `ARK-T8`, each once.
- The two later calls print `ARK-T9` in `run-a` and `ARK-T10` in `run-b`: the counter makes them new although neither worktree holds the other's entries.
- The call after the higher local entry prints `ARK-T31` in `run-a`: one above the highest entry of the current worktree.
- The call after the higher fetched target entry prints `ARK-T31` in `run-b`: one above the highest entry at the target head.

## Screenshot checkpoints

None, CLI output. The surface is the id printed on stdout; no screen applies.
