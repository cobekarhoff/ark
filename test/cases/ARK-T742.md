---
id: ARK-T742
title: ARK-T742 The time verdict of ark test is made once on the head results of a full run from the current ark.yml: a quick run, a reused suite, a retried file, a missing time, each parser and an invalid key each have a stated result
level: integration
technique: equivalence classes over the ways into the verdict (full run, quick run, cache reuse, retry replace, report with no time, each parser) and error guessing at the config boundary (zero, negative, text, unknown value of `on_over`)
priority: high
risk: a quick run (a part of a suite) fails or prints a suite budget it cannot know; a reused suite is judged from limits that were stored, or loses its suite time or its test times so a slow test or an over budget passes in silence, or a changed limit in ark.yml is ignored because the verdict was cached; a retry replaces the results of one file and the verdict reads the first run or drops the files the retry did not touch; a report with no `time` crashes the run or reads as 0 and passes as proof; a time failure is recorded as a failed file, so the next run's pre-run re-runs files for nothing; a pytest or behave project drops its test times and lists no slow test; an invalid key is accepted and the budget does nothing
status: active
changed_by: 2026-11-20-ARK-581-1
---

## Objective

Prove the edges around the verdict of ARK-T741 (AC1 of ARK-581) at the real `ark test` boundary: where the verdict is computed, what a run that cannot know a time prints, what a time failure leaves behind for the next run, that each parser carries its test times, and that a wrong key is refused at load.

Authoring gate:

1. Protects: the contract that one verdict is made from the head results of a full run, after cache replay and retry, from the current `ark.yml`; the handling of the items a reader would skip (a test with no `time`, a reused entry with no durations, the files a retry did not touch); the refusal of bad keys at load.
2. Fails when: the verdict is stored in the cache or is made before the retry, a reused suite is judged by the stored limits or loses its times, a quick run fails in fail mode, a missing `time` throws or counts as over, a time failure names a file in `failed_files`, a parser drops `duration_s`, or `loadConfig` accepts a bad value.
3. Existing proof misses it: ARK-T741 owns the matrix of one fresh full run and never reuses, retries, runs quick, parses pytest or behave, or loads a bad key. `test/test-selection.test.ts` and ARK-T740 own the quick selection and never set a key. ARK-T163 owns the cache key and ARK-T164 the retry and its flaky line; neither reads a time. This case adds the lifecycle and input contracts, and does not repeat the matrix.
4. No test-only export, flag or hook: the real `ark` process, a fake suite command that writes a report and a temp `ark.yml`.

## Time source rule (test/wallclock.test.ts, ARK-T126)

As ARK-T741: every time is a number in a fixture report written by the fake suite command; no sleep, no wait on real time.

## Preconditions

- The fixture of ARK-T741 (the `e2e` suite with the fake command, `head.marker` committed on the run's branch, three tests of 0.5 s, 2.0 s and 3.5 s, root `time` 12). The counter of the fake command counts the calls made where `head.marker` exists, so the count is the head calls only; the base run and the census call the same command and are not counted.
- Steps 3 to 5 also commit `a.test.ts` and `b.test.ts` on the run's branch (any content): the main check skips a file the run touched (`cli/test-run.ts:936-938`), so a failing file stays failed, and the pre-run of the next run runs only a file that exists in the worktree (`cli/test-run.ts:1353`).
- A step that needs a reused suite keeps the same head commit and the same command text, so the second call reuses the suite as `test/test-run.test.ts` shows. A stored entry is made only by a suite that passed.

## Steps

1. Reuse with a changed limit. Report: the three tests of ARK-T741, root `time` 12. Run 1: no key, `ark test <run>` (the suite runs; head count 1). Run 2: `slow_test_s: 2`, `on_over: fail`, no budget. Run 3: `time_budget_s: 10`, `slow_test_s: 4`, `on_over: fail`. Run 4: `time_budget_s: 20`, `slow_test_s: 4`, `on_over: fail`. Each run is a reuse of run 1's entry.
2. Quick run. `on_over: fail`, `slow_test_s: 2`, `time_budget_s: 10`. The `e2e` suite has `base_files: a.test.ts` and a `base_command` that writes the report with `FAKE-T3 slow` at 3.5 s and root `time` 12 (the `base_files` and `base_command` shape of the `oneNotRun` fixture in ARK-T720's test); the run's branch commits `a.test.ts`. Run `ark test <run> --quick`.
3. Retry replace. The `e2e` suite has `base_command` (the retry). The suite command's report (exit 1): `a.test.ts` holds `FAKE-T4 other` at 5.0 s (passed); `b.test.ts` holds `FAKE-T3 flaky` at 0.5 s (failed) and `FAKE-T2 limit` at 9.0 s (passed); each `<testcase>` carries its `file`. The retry's report (exit 0), for `b.test.ts`: `FAKE-T3 flaky` 0.4 s and `FAKE-T2 limit` 0.4 s, both passed. `slow_test_s: 2`, `on_over: fail`, no `time_budget_s` (the suite time after a retry is not pinned by this case). Run `ark test <run>`.
4. A suite that fails on its own. The same fixture, but the retry's report is the first report again (`FAKE-T3 flaky` fails twice). `slow_test_s: 2`, `on_over: fail`. Run `ark test <run>`; read the `test.completed` suite row.
5. A time failure only. `on_over: fail`, `slow_test_s: 2`; report: `FAKE-T4 other` 5.0 s in `a.test.ts`, no failing test; `base_command` set (it writes a passing report). Run `ark test <run>`. Then set `slow_test_s: 6` and run `ark test <run>` again.
6. A report with no `time` (root and `<testcase>` have no `time` attribute); `slow_test_s: 2`, `time_budget_s: 10`, `on_over: fail`. Run `ark test <run>` twice (the second reuses the suite).
7. Each parser. The suite has `slow_test_s: 2`, `on_over: fail`. One run with `parser: pytest` and a JUnit report (`<testcase time>`; `FAKE-T1 fast` 0.5 s, `FAKE-T3 slow` 3.5 s, a `case` property on each). One run with `parser: behave` and a JSON report in the shape behave writes (`test/fixtures/parsers/behave-cases-report.json`): the scenario element carries no `duration`, only `steps[].result.duration`. Scenario `@FAKE-T1` has two steps of 0.25 s each (sum 0.5 s); scenario `@FAKE-T3` has two steps of 1.5 s and 2.0 s (sum 3.5 s). Then `slow_test_s: 4` on each.
8. Invalid keys. For each of `slow_test_s: 0`, `slow_test_s: -1`, `time_budget_s: "ten"`, `on_over: stop` and `on_over: ""`, run `ark test <run>`.

## Expected results

- Step 1: run 1 exits 0 with head count 1. Run 2 exits 1, `passed: false`, lists `FAKE-T3 slow` at 3.5 s against 2 s. Run 3 exits 1 and names the suite over its budget of 10 s with the suite time 12 s (a reused suite carries its suite time, so it reads as a fresh run does), and lists no slow test. Run 4 exits 0 with no warning. In runs 2 to 4 the head count is still 1 and the stored entry does not change: the limits are read from the current `ark.yml`, not from the cache, and a reused suite over its budget never reads as inside it.
- Step 2: exit 0 and `mode: "quick"` in `test.completed`: the quick run lists `FAKE-T3 slow` and prints no suite budget verdict (a part of a suite has no suite time), and is no gate, so fail mode does not fail it (the same exit as the keys-less run).
- Step 3: the verdict reads the results after the retry. `FAKE-T4 other` (a file the retry did not touch, 5.0 s) is listed as slow and fails the run: exit 1. `FAKE-T2 limit` is not listed: its 9.0 s was in the replaced file. `b.test.ts` is listed as flaky as ARK-T164 owns, and the suite passes (the only failure is the time failure).
- Step 4: exit 1 and `passed: false`; the output names the failing suite and the slow test `FAKE-T4 other` in separate lines; the `e2e` row has `failed_files` of exactly `["b.test.ts"]`, with no entry for the time failure or for `a.test.ts`.
- Step 5: the first run exits 1 with the time failure; its `e2e` row has no `failed_files`. The second run exits 0, prints no `ark test: failed files of the last test, run first` line, runs no pre-run, and reuses the suite (head count 1). A time failure that records every file as failed re-runs the files for nothing.
- Step 6: both runs exit 0 in fail mode; no crash, no `NaN`, no slow line, and the suite time is not printed as 0 nor judged against the budget; the output says the report has no time (the first run) and that the reused suite has no durations (the second run). A missing time is not a time over. The validator pins the wording from the implementation.
- Step 7: each parser: exit 1 with `FAKE-T3 slow` listed at 3.5 s; with `slow_test_s: 4` exit 0 and no slow line. The suite budget of these parsers follows the suite time source the implementation chooses; this step asserts the slow-test limit only.
- Step 8: each bad value exits 1 at load with a message that names the key and the allowed values (a positive number; `warn` or `fail`); no suite runs (the head count stays 0).

## Screenshot checkpoints

none: CLI output and event-log case; no UI surface.
