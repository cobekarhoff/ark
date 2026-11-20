---
id: ARK-T741
title: ARK-T741 A full ark test prints the suite time and every test over slow_test_s, warns and passes with on_over warn, fails with on_over fail, and does not change with no key set
level: integration
technique: boundary values (a time equal to the limit is not over, one hair above is) and equivalence classes (no key, warn, fail, test over, suite over, both over, neither over) read from a fixture JUnit report
priority: high
risk: the verdict reads the wrong figure (wall time of the fake command instead of the report's `time`, or a sum of testcase times instead of the suite time) so a fixture report cannot move it; or `>=` replaces `>` at the limit; or `on_over: fail` is ignored, or a warn run writes `passed: false` or exits 1, or a fail run keeps exit 0 or `passed: true` in `test.completed`; or a project with none of the keys gets a new line or a changed result; or only one of the two limits (suite budget or slow test) takes part in the verdict
status: active
changed_by: 2026-11-20-ARK-581-1
---

## Objective

Prove AC1 of ARK-581 through the real `ark test` process: a suite in `ark.yml` can give `time_budget_s`, `slow_test_s` and `on_over`; a full run prints the suite time and every test over `slow_test_s`; an over budget or an over test warns and passes with `on_over: warn` (the default) and fails with `on_over: fail`; with none of the keys the output and result do not change.

Authoring gate:

1. Protects: the config contract of three suite keys and the visible result of a full `ark test` (output lines, exit code, `passed` of `test.completed`).
2. Fails when: the figures come from anything but the report (wall time, a testcase sum), the comparison is `>=`, `on_over` is not read or is read for only one of the two limits, a warning changes the result, or a project with no key sees any change.
3. Existing proof misses it: no test reads a time from a report, and `test/test-run.test.ts` and ARK-T740 never set a key. This case is the only owner of the verdict matrix. Quick runs, a reused suite, a retry, a failing suite, a missing `time` and invalid keys are owned by ARK-T742; the slow reason by ARK-T743.
4. No test-only export, flag or hook: the case runs the real `ark` process, with a suite command that is a fake script writing a JUnit file.

## Time source rule (test/wallclock.test.ts, ARK-T126)

Every time is a number in a fixture report. The fake suite command copies a prepared JUnit file to `{report}` and exits at once (`writeFakeCommand`, `writeProject`, `test/helpers.ts`); the file has `time` on the `<testsuites>` root and on each `<testcase>`. The test holds no `setTimeout(`, `Bun.sleep(` or `waitForTimeout(`, and no real test sleeps: a figure of 900 s costs the same as 0.01 s. The suite time is the root `time` of the report. A run that reads the wall time of the command reads about 0 s on every fixture below and fails the cases that expect an over budget.

## Preconditions

- A temp `ARK_HOME`, a single-repo workspace and a project whose suite uses `parser: bun` with the fake suite command, as `buildingRun` of `test/test-run.test.ts` builds it. The criteria and test titles carry a case id (`FAKE-T1 ...`) so the run records them as passing; no test carries a `slow_reason` (ARK-T743).
- The report of every fixture has three passing tests: `FAKE-T1 fast` 0.5 s, `FAKE-T2 limit` 2.0 s, `FAKE-T3 slow` 3.5 s, in files `a.test.ts` and `b.test.ts`. Only the root `time` and the `ark.yml` keys change between steps.
- The project's `ark.yml` is rewritten between steps; a limit change must not need a new fixture, because the verdict is computed from the current `ark.yml` (the cache key does not hold the limits).

## Steps

Each step runs `ark test <run>` (full, no `--quick`) in a fresh run or after `ark test` cleared the reused entry (the suite command's file changes with a counter so the suite runs again), reads the exit code, stdout and the last `test.completed`.

1. No key. Root `time` 900. Read the output and result.
2. `slow_test_s: 2`, no `on_over`, no `time_budget_s`. Root `time` 7.
3. `time_budget_s: 10`, no `slow_test_s`, no `on_over`. Root `time` 10 (equal to the budget), then root `time` 10.01.
4. `time_budget_s: 10` and `slow_test_s: 2`, no `on_over`. Root `time` 12.
5. `on_over: warn` set explicitly, same keys and report as step 4.
6. `on_over: fail`, `slow_test_s: 2`, no budget. Root `time` 7.
7. `on_over: fail`, `time_budget_s: 10`, no `slow_test_s`. Root `time` 12.
8. `on_over: fail`, `time_budget_s: 10`, `slow_test_s: 2`, root `time` 12.
9. `on_over: fail`, `time_budget_s: 10` and `slow_test_s: 3.5`, root `time` 10 (every figure at its limit: nothing is over).
10. `on_over: fail` and `slow_test_s: 2` with a report whose tests are all 0.5 s and root `time` 7 (nothing over a limit that is set).

## Expected results

- Step 1: no line about time, a budget or a slow test; the same stdout and exit code as the run of the same fixture before this change (the validator compares it with a run on a project whose report has no `time`), `passed: true`. The existence of the three keys changes nothing for a project that does not set them.
- Step 2: exit 0, `passed: true`. The output prints the suite time (7 s, with the suite name) and lists `FAKE-T3 slow` with its 3.5 s and the limit of 2 s, and does not list `FAKE-T2 limit` (2.0 is not over 2) or `FAKE-T1 fast`. The output marks the line as a warning, so a reader can tell a warn from a failure. `test.completed` has `passed: true`.
- Step 3: root `time` 10: exit 0, the suite time is printed, no over-budget warning. Root `time` 10.01: exit 0, `passed: true`, the output warns that the suite is over its budget of 10 s and names the suite time.
- Step 4: exit 0, `passed: true`; both warnings appear (the suite over its budget and `FAKE-T3 slow`).
- Step 5: the same stdout figures, exit code and `passed` as step 4 (`warn` is the default).
- Step 6: exit 1, `passed: false` in `test.completed`; the output lists `FAKE-T3 slow` and names the slow test limit as the reason the run failed; no budget line.
- Step 7: exit 1, `passed: false`; the output names the suite budget as the reason; no slow test line, because `slow_test_s` is not set.
- Step 8: exit 1, `passed: false`; the output names both reasons.
- Step 9: exit 0, `passed: true`, the suite time printed, no warning and no failure line (`on_over: fail` fails only what is over).
- Step 10: exit 0, `passed: true`, no slow test line.
- In steps 2 to 10 the other suite lines, the `tests` line and the criteria rows read as in step 1: a time check adds lines and can only change the exit and `passed`.

## Screenshot checkpoints

none: CLI output and event-log case; no UI surface.
