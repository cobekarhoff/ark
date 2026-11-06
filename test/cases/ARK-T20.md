---
id: ARK-T20
title: ARK-T20 the every-file timeout check of ARK-237 refuses a 10 second sync-style test
level: integration
technique: boundary values (10 s against the 30 s minimum)
priority: medium
risk: moving the five-process ARK-237 test behind ARK_LOAD_PROOF also drops or weakens the cheap check that every git-heavy test has a timeout of at least 30 seconds, so a short timeout passes unseen
status: active
changed_by: 2026-11-06-ARK-319-1
---

## Objective

Prove that the every-file ARK-237 check, which runs by default, refuses a sync or merge-request style test with a timeout below 30 seconds. Serves ARK-326/AC2 and ARK-319/AC4.

Expected: If a test that starts a run or builds a scenario has a timeout below 30 seconds, then the check shall report that test.

## Preconditions

- A temporary fixture file with two top-level tests: one that calls `startRun(` with `{ timeout: 10_000 }`, and one that calls `scenario(` with `{ timeout: 30_000 }`.
- The check is the `gitHeavyTests` helper that `ARK-237-AC1` uses, taking the fixture path relative to the repository root.

## Steps

1. Run the check on the fixture file.
2. Read the tests it reports as too short.

## Expected results

- Exactly one test is reported: the 10 second test, with timeout 10000.
- The 30 second test is not reported (the boundary passes).
- `ARK-237-AC1` still runs without `ARK_LOAD_PROOF` and passes on `test/sync.test.ts` and `test/merge-request.test.ts`.

## Screenshot checkpoints

None, CLI output.
