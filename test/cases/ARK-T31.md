---
id: ARK-T31
title: ARK-T31 every sync, merge-request and post-mr test that starts a run or builds a scenario through a helper has a timeout of at least 30 seconds
level: integration
technique: boundary values (each timeout against the 30 s minimum)
priority: medium
risk: a sync, merge-request or post-mr test that starts a run or builds a scenario (directly or through generatedScenario(, submoduleRun( or openRun() gets no timeout, or a named constant below 30 seconds, so it times out on a busy host and the guard that exists for that case passes
status: active
changed_by: 2026-11-20-ARK-600-1
---

## Objective

Prove that every test in `test/sync.test.ts`, `test/merge-request.test.ts` and `test/post-mr.test.ts` that starts a run or builds a scenario (a call of `startRun(`, `scenario(`, `generatedScenario(`, `submoduleRun(` or `openRun(`) sets its own timeout of at least 30 seconds, written as a number or as a named constant. Converted from the legacy test ARK-237-AC1; serves ARK-319/AC4 and ARK-600/AC1.

Expected: When a sync, merge-request or post-mr test starts a run or builds a scenario, the system shall require its own timeout of at least 30 seconds.

## Preconditions

- A checkout with `bun` installed.
- `ARK_LOAD_PROOF` is unset: the check is not behind that switch.

## Steps

1. Run `bun test test/timeouts.test.ts -t ARK-T31`.
2. Read the exit code and the pass and skip counts.

## Expected results

- Exit code 0, `1 pass`, no non-zero `skip` count.
- At least one git-heavy test is found in each of the three files, and none lacks a timeout or has one below 30000 milliseconds. This covers the five `generatedScenario(` tests of `test/sync.test.ts` (the four ARK-T384 tests and ARK-T385), the `submoduleRun(` and `openRun(` tests of `test/post-mr.test.ts`.
- The refusals of the guard (no limit, a constant below 30 s, an unresolved name, helper definitions) are proven by ARK-T30.

## Screenshot checkpoints

None, CLI output.
