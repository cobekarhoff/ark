---
id: ARK-T20
title: ARK-T20 the every-file timeout check of ARK-T21 refuses a 10 second sync-style test
level: integration
technique: boundary values (10 s against the 30 s minimum)
priority: medium
risk: moving the five-process ARK-T22 test behind ARK_LOAD_PROOF also drops or weakens the cheap check that every git-heavy test has a timeout of at least 30 seconds, so a short timeout passes unseen
status: active
changed_by: 2026-11-06-ARK-319-1
---

## Objective

Prove that the owning every-file check ARK-T21, which runs by default, runs without `ARK_LOAD_PROOF` and refuses a sync or merge-request style test with a timeout below 30 seconds. Serves ARK-326/AC2 and ARK-319/AC4.

Expected: If a test that starts a run or builds a scenario has a timeout below 30 seconds, then the check shall report that test.

## Preconditions

- A checkout with `bun` installed.
- A temporary repository folder holds `test/fixture.test.ts` with two top-level tests: one that calls `startRun(` with `{ timeout: 10_000 }`, and one that calls `scenario(` with `{ timeout: 30_000 }`.
- The folder also holds a copy of `test/timeouts.test.ts` whose `gitHeavyFiles` list is replaced by `["test/fixture.test.ts"]`.

## Steps

1. Run `bun test test/timeouts.test.ts -t ARK-T21` in the repository in a child process with `ARK_LOAD_PROOF` removed. Read the exit code and the counts.
2. Run `bun test test/timeouts.test.ts -t ARK-T21` in the temporary folder in a child process with `ARK_LOAD_PROOF` removed. Read the exit code and the output.

## Expected results

- Step 1: exit code 0, `1 pass`, no non-zero `skip` count: the owning check runs by default and passes on the real files.
- Step 2: a non-zero exit code. The output reports the 10 second test (`opens a merge request`, timeout 10000) and does not name the 30 second test (the boundary passes).

## Screenshot checkpoints

None, CLI output.
