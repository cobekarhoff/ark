---
id: ARK-T741
title: ARK-T741 A full ark test prints the suite time and every test over slow_test_s, warns and passes with on_over warn, fails with on_over fail, and does not change with no key set
level: integration
technique: boundary values (a time equal to the limit is not over, one hair above is) and equivalence classes (no key, warn, fail, test over, suite over, both over, neither over) read from a fixture JUnit report
priority: high
risk: "the verdict reads the wrong figure (wall time of the fake command instead of the report's `time`, or a sum of testcase times instead of the suite time) so a fixture report cannot move it; or `>=` replaces `>` at the limit; or `on_over: fail` is ignored, or a warn run writes `passed: false` or exits 1, or a fail run keeps exit 0 or `passed: true` in `test.completed`; or a project with none of the keys gets a new line or a changed result; or only one of the two limits (suite budget or slow test) takes part in the verdict; or a report that is not the head's (the base run or the census, which run the whole suite) feeds the verdict; or the keys of one suite are applied to another suite (a project-wide read, the first suite's `on_over`), so a limit or a failure of one suite shows on another"
status: active
changed_by: 2026-11-20-ARK-581-1
---

## Objective

Prove AC1 of ARK-581 through the real `ark test` process: a suite in `ark.yml` can give `time_budget_s`, `slow_test_s` and `on_over`; a full run prints the suite time and every test over `slow_test_s`; an over budget or an over test warns and passes with `on_over: warn` (the default) and fails with `on_over: fail`; with none of the keys the output and result do not change.

Authoring gate:

1. Protects: the config contract of three suite keys and the visible result of a full `ark test` (output lines, exit code, `passed` of `test.completed`).
2. Fails when: the figures come from anything but the head report (wall time, a testcase sum, the base or census report), the comparison is `>=`, `on_over` is not read or is read for only one of the two limits, a warning changes the result, a project with no key sees any change, or the keys of one suite judge another suite.
3. Existing proof misses it: no test reads a time from a report, and `test/test-run.test.ts` and ARK-T740 never set a key. This case is the only owner of the verdict matrix. Quick runs, a reused suite, a retry, a failing suite, a missing `time`, the pytest and behave parsers and invalid keys are owned by ARK-T742; the slow reason by ARK-T743.
4. No test-only export, flag or hook: the case runs the real `ark` process, with a suite command that is a fake script writing a JUnit file.

## Time source rule (test/wallclock.test.ts, ARK-T126)

Every time is a number in a fixture report. The fake suite command copies a prepared JUnit file to `{report}` and exits at once (`writeFakeCommand`, `writeProject`, `test/helpers.ts`); the file has `time` on the `<testsuites>` root and on each `<testcase>`. The test holds no `setTimeout(`, `Bun.sleep(` or `waitForTimeout(`, and no real test sleeps: a figure of 900 s costs the same as 0.01 s. The suite time is the root `time` of the report. A run that reads the wall time of the command reads about 0 s on every fixture below and fails the cases that expect an over budget.

## Preconditions

- A temp `ARK_HOME`, a single-repo workspace and a project whose suites are `unit` and `e2e`, as `buildingRun` of `test/test-run.test.ts` builds them (the `e2e` suite gets the fake command through `e2eCommand`, the `unit` suite through `suiteOverrides`, which replaces `command`; no `selectiveBase`). Both suites use `parser: bun`. Steps 1 to 11 key and fake only `e2e`; the `unit` suite there runs its real, empty `unit.test.ts` and has no key. The criteria and test titles carry a case id (`FAKE-T1 ...`) so the run records them as passing; no test carries a `slow_reason` (ARK-T743).
- The fake command of a suite is `sh -c 'if [ -e head.marker ]; then cp <head report> {report}; else cp <base report> {report}; fi; <counter>'`, where `<counter>` appends one line to a file outside the repo: `head` or `base` by the same test. The run's branch holds one commit that adds `head.marker` (`commitFiles`, as the fixtures of ARK-T740 do), so the head checkout has the file and the base checkout (the base commit plus the head's changed files under a test folder) has not. Until step 11 the two reports are the same file.
- The report of every step has three passing tests: `FAKE-T1 fast` 0.5 s, `FAKE-T2 limit` 2.0 s, `FAKE-T3 slow` 3.5 s, in files `a.test.ts` and `b.test.ts`. Only the root `time` and the `ark.yml` keys change between steps.
- The cache key holds the suite command text and the head commit, and not the report or the limits. A step that needs a fresh run changes the command text with a new trailing `# <n>`; a step that needs a reused suite keeps it (ARK-T742).
- The project's `ark.yml` is rewritten between steps: a limit change needs no new fixture, because the verdict is computed from the current `ark.yml`.

## Steps

Each step runs `ark test <run>` (full, no `--quick`) as a fresh run (a new `# <n>` on the command, see Preconditions), and reads the exit code, stdout and the last `test.completed`.

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
11. Base and census reports. `on_over: fail`, `slow_test_s: 2`, `time_budget_s: 10`. Head report: the three tests of every step with `FAKE-T3 slow` at 0.5 s, plus `FAKE-T9 base only` at 0.5 s in `b.test.ts`, root `time` 4. Base report: the same four tests with the same names and files, but `FAKE-T9 base only` at 9 s and root `time` 30. Only the time of `FAKE-T9 base only` differs, so the census lists the same tests as the head and no test reads as deleted (`deletedTests`, `cli/test-run.ts:230-249`). A full run with no `base_files` runs the whole suite command at the base commit and again in the census (`baseSuitesPassed`, `cli/test-run.ts:775-822`), so both parse the base report.
12. Two suites. The `unit` suite has the fake command, which writes one report for head, base and census, and `unit` is listed before `e2e`. Each of 12a and 12b is read against the same two-suite fixture (same reports, same commands) run once with no key in either suite, as a fresh run (a new `# <n>`): that keyless run is the reference for the suite lines, the `tests` line and the criteria rows, because in step 1 the `unit` suite runs the empty `unit.test.ts` and here it runs the fake report with its own tests.
    - 12a: `unit` has `time_budget_s: 10` and `on_over: fail`, report with tests of 0.5 s and root `time` 5 (inside its budget). `e2e` has `slow_test_s: 2` and `on_over: warn` and the report of step 2 (root `time` 7).
    - 12b: `e2e` has `slow_test_s: 2` and `on_over: fail` and a report with tests of 0.5 s (root `time` 4). `unit` has no key and a report with `FAKE-T5 slower` at 6.0 s and root `time` 20.

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
- Step 11: exit 0, `passed: true`; the output prints the `e2e` suite time 4 s and no line names a suite time of 30 s or a 9 s test, and no `deleted` line appears (the head lists `FAKE-T9 base only` too). The counter file holds a `head` line and at least one `base` line, so the case cannot pass because the base run never happened (the base and the census both run the command: do not pin the count).
- Step 12a: exit 0, `passed: true`. `FAKE-T3 slow` is listed under `e2e` as a warning; nothing is listed for `unit`; no failure line. A read of `on_over` from the first suite or project-wide (`unit` is `fail`) exits 1.
- Step 12b: exit 0, `passed: true`. No slow-test line and no budget line for either suite; `FAKE-T5 slower` is not listed and the `unit` suite line reads as in the keyless run. A read of `slow_test_s` or `time_budget_s` across suites lists it or fails the run.
- Steps 2 to 11: the suite lines (without the `head <n>s` figure, the wall time of the fake command, which no step compares), the `tests` line and the criteria rows read as in step 1, except that the `tests` line of step 11 counts one more passed test (`FAKE-T9 base only`). Steps 12a and 12b read as in their keyless run, as above. A time check adds lines and can only change the exit and `passed`.

## Screenshot checkpoints

none: CLI output and event-log case; no UI surface.
