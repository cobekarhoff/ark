---
id: ARK-T720
title: ARK-T720 a quick ark test --keep-going that records every non-manual AC failing is the bug run's red proof, and a quick run that leaves one AC not run is refused
level: integration
technique: equivalence classes of quick-run criterion status (every AC failing past a failed check, one AC not run) over the consumer of test.completed that gates the implementer start
priority: high
risk: "a change to the red-proof reader (redTest in cli/events.ts, the step.started gate in cli/transitions.ts) or to quickStatus (cli/test-run.ts) stops counting a quick run, or --keep-going is honoured only in full mode so a quick run stopped by a failed check leaves every AC not run, so the validator's cheap red proof is refused and every bug run pays one more full suite plus base run; or the reverse, a quick run that leaves an AC not run (its case is in a file the quick run did not select) is accepted as a red proof and the implementer starts on proof that never ran"
status: active
changed_by: 2026-11-20-ARK-587-1
---

## Objective

Pin the contract that the skills of ARK-587 rely on: in a bug run, `ark test <run> --quick --keep-going` is a red proof when it records every non-manual AC `failing`, even when a check failed (a red test often fails `typecheck` or `lint` because it imports a fix that does not exist yet), and it is no red proof when any AC reads `not run`. Serves ARK-587/AC1.

Authoring gate:

1. Protects: the bug-run gate of `ark run step <run> <implementer step> start` reading a `test.completed` event of mode `quick`, and `--keep-going` running the suites in quick mode past a failed check.
2. Fails when: the gate or `redTest` ignores `mode: quick` (half 1 turns red), `--keep-going` stops the quick run at the failed check (half 1 turns red: every AC reads `not run`), or a quick `not run` counts as `failing` (half 2 turns red).
3. Existing proof misses it: ARK-T665 runs a failed check with `--keep-going` in full mode, and a failed check in quick mode without `--keep-going`. No case runs a failed check with `--quick --keep-going`, and no case feeds a mixed `failing` / `not run` quick result into the gate. ARK-T475 and ARK-T62 reach the gate with events, with no `ark test`. This case adds the quick-mode transport only, not a second owner of the gate.
4. No test-only export, flag or hook: the case runs the real `ark` process against the fixture.

## Preconditions

- Fixture of `test/test-run.test.ts` (`bugRun`, `kind: bug`, `installFakeOrca()` called before any `ark run step ... start`), with two ticket criteria `AC1` (verified_by `FAKE-T1`) and `AC2` (verified_by `FAKE-T2`), both `method: test`, and plan criteria `FAKE-1/AC1`, `FAKE-1/AC2`. The plan `test_cases` lists both `FAKE-T1` and `FAKE-T2` as `add` entries (`bugRun()` lists only `FAKE-T1`, so the fixture overrides `testCases`; without `FAKE-T2` the plan check and the plan-membership check of `ark test` refuse the fixture). Plan steps: a validator `tests` (needs none) and an implementer `build` (needs `tests`). One check `lint` whose command exits 1 while the `failureSwitch` file exists and 0 otherwise (as ARK-T665).
- Fixture A: the e2e suite has no `base_files`, so a quick run runs the whole suite. The `failureSwitch` file exists. One validator commit in the worktree writes `e2e.test.ts` with a failing test titled `FAKE-T1 ...` and a failing test titled `FAKE-T2 ...`.
- Fixture B (as ARK-T388 "quick, file selection"): the `failureSwitch` file does not exist (the check passes). The e2e suite has `base_files: e2e.test.ts` and a `base_command` with `{files}`; the full command runs `./e2e.test.ts` and `./other.test.ts`. One validator commit changes `e2e.test.ts` to hold a failing `FAKE-T1 ...` test and adds `other.test.ts` with a failing `FAKE-T2 ...` test. A quick run selects only own-commit files that match `base_files` (`ownTestFiles`), so it runs `e2e.test.ts` and not `other.test.ts`, although the commit contains both.

## Steps

1. Fixture A. Run `ark test <run> --quick --keep-going`. Read the exit code, stdout, stderr and the last `test.completed` of `events.ndjson`.
2. Run `ark run step <run> build start`.
3. Fixture B (fresh run). Run `ark test <run> --quick --keep-going`. Read the exit code, stdout and the last `test.completed`.
4. Run `ark run step <run> build start`. Read the exit code and stderr.

## Expected results

- Step 1: exit 1. stderr contains `check lint failed` and `suite e2e failed`. stdout has `FAKE-1/AC1  failing` and `FAKE-1/AC2  failing`. `test.completed` has `mode: "quick"` and `criteria: { "FAKE-1/AC1": "failing", "FAKE-1/AC2": "failing" }` (the failed check did not stop the quick run).
- Step 2: exit 0; `step.started` for `build` is recorded (the quick run is the red proof).
- Step 3: exit 1. `test.completed` has `mode: "quick"`, `FAKE-1/AC1` is `failing` and `FAKE-1/AC2` is `not run` (not `failing`, not `missing`: its failing test sits in a file the quick run did not select).
- Step 4: exit 1; stderr contains `bug run: record a failing ark test of the ACs before the fix`; no `step.started` for `build` is recorded.
- This case does not assert the call shape of `orca orchestration worker-start`, the `red_on_main` record, or that `ark merge-request open` refuses a last quick run (ARK-T327 owns `red_on_main`, ARK-T121 owns the refusal of a last quick run).

## Screenshot checkpoints

none: CLI and event-log case; no UI surface.
