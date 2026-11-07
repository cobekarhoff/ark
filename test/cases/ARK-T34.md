---
id: ARK-T34
title: ARK-T34 first call without counter reads the target branch
level: integration
technique: boundary values (first use, no counter) and equivalence classes (own key, other key)
priority: high
risk: the first call after the counter is introduced starts from the worktree's entries only and reuses an id that the target branch already holds
status: active
changed_by: 2026-11-06-ARK-319-1
---

## Objective

Prove that with no counter yet, the next id is one above the highest entry of the same key on the head of the target branch, although the worktree lacks those entries. Serves ARK-319/AC2.

Expected: When no counter exists, the system shall number the next case above the highest entry on the target branch.

## Preconditions

- One git repo with a bare origin (origin/HEAD names main) and no id counter.
- A worktree `run-a` on a branch created before main gained its entries, so its `test/cases/` is empty.
- origin/main holds `test/cases/ARK-T3.md`, `ARK-T12.md` and `OTHER-T40.md`, and the repo has fetched them.

## Steps

Command: `bun test test/test-case.test.ts`

1. Run `ark test-case new ARK` in `run-a`.
2. Read the printed id.

## Expected results

- The command exits 0 and prints `ARK-T13`: one above the highest `ARK-` entry on main. The `OTHER-T40` entry of another key does not raise it.

## Screenshot checkpoints

None, CLI output. The surface is the id printed on stdout; no screen applies.
