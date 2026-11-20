---
id: ARK-T742
title: ARK-T742 The time verdict of ark test is made once on the head results of a full run from the current ark.yml: a quick run, a reused suite, a retried file, a missing time and an invalid key each have a stated result
level: integration
technique: equivalence classes over the ways into the verdict (full run, quick run, cache reuse, retry replace, report with no time) and error guessing at the config boundary (zero, negative, text, unknown value of `on_over`)
priority: high
risk: a quick run (a part of a suite) fails or prints a suite budget it cannot know; a reused suite is checked against durations that were never stored, so a slow test passes in silence or a changed limit in ark.yml is ignored because the verdict was cached; a retry replaces results and the verdict reads the first run; a report with no `time` crashes the run or reads as 0 and passes as proof; a time failure is recorded as a failed file, so the next run's pre-run re-runs files for nothing; an invalid key is accepted and the budget does nothing
status: active
changed_by: 2026-11-20-ARK-581-1
---

## Objective

Prove the edges around the verdict of ARK-T741 (AC1 of ARK-581) at the real `ark test` boundary: where the verdict is computed, what a run that cannot know a time prints, what a time failure leaves behind for the next run, and that a wrong key is refused at load.

Authoring gate:

1. Protects: the contract that one verdict is made from the head results of a full run, after cache replay and retry, from the current `ark.yml`; the handling of the items a reader would skip (a test with no `time`, a reused entry with no durations); the refusal of bad keys at load.
2. Fails when: the verdict is stored in the cache or is made before the retry, a quick run fails in fail mode, a missing `time` throws or counts as over, a time failure names a file in `failed_files`, or `loadConfig` accepts a bad value.
3. Existing proof misses it: ARK-T741 owns the matrix of one fresh full run and never reuses, retries, runs quick or loads a bad key. `test/test-selection.test.ts` and ARK-T740 own the quick selection and never set a key. This case adds the lifecycle and input contracts, and does not repeat the matrix.
4. No test-only export, flag or hook: the real `ark` process, a fake suite command that writes a JUnit file and a temp `ark.yml`.

## Time source rule (test/wallclock.test.ts, ARK-T126)

As ARK-T741: every time is a number in a fixture JUnit report written by the fake suite command; no sleep, no wait on real time. The fake command counts its own runs in a marker file, so a test can tell a reused suite from a run. The retry fixture uses a fake command that writes one report on its first call and another on its second (a flaky file: a failing test, then a passing one with other times), keyed by the marker file.

## Preconditions

- The fixture of ARK-T741 (three tests, 0.5 s, 2.0 s and 3.5 s, `slow_test_s: 2`, `time_budget_s: 10`, root `time` 12) unless a step says otherwise.
- A step that needs a second `ark test` of the same run keeps the same head commit and the same suite command, so the second call reuses the suite as `test/test-run.test.ts` shows.

## Steps

1. Reuse with a changed limit. `on_over: warn`: run `ark test <run>` (the suite runs, marker count 1). Then change `ark.yml` to `on_over: fail` and run `ark test <run>` again (the suite is reused, marker count still 1). Then change `slow_test_s` to 4 and `time_budget_s` to 20 and run again.
2. Reuse of an entry with no durations. Prepare a stored suite entry of an earlier ark (results with no durations and no `wall_s`) by running the fixture on the real code with a report that has no `time` attributes and then giving the project `slow_test_s: 2`, `on_over: fail`; run `ark test <run>` a second time (reused).
3. Quick run. With `on_over: fail`, `slow_test_s: 2` and `time_budget_s: 10`, run `ark test <run> --quick` on a suite that the quick selection runs in part (`base_files` or `changed_command`, as ARK-T740).
4. Retry replace. The suite command's first call writes a report where `FAKE-T3 slow` fails and `FAKE-T2 limit` takes 9 s; its second call (the file retry) passes `FAKE-T3 slow` in 0.4 s and `FAKE-T2 limit` in 0.4 s. `slow_test_s: 2`, `on_over: fail`.
5. A suite that fails on its own. `on_over: fail`, `time_budget_s: 10`, root `time` 12, and one test fails (a real failing test, not slow). Run `ark test <run>`, read `test.completed`. Then run `ark test <run>` again, read the pre-run lines and the `failed_files` of the last event.
6. A time failure only. `on_over: fail`, one slow test, no failing test. Run `ark test <run>`. Then fix the project (`slow_test_s: 4`) and run `ark test <run>` again.
7. A report with no `time`. Root and testcase `time` attributes are absent; `slow_test_s: 2`, `time_budget_s: 10`, `on_over: fail`. Run `ark test <run>`.
8. A report that has `time` on the root and on testcases, and a test with no case id (`neither`, 5 s) and a test with a case id; `slow_test_s: 2`, `on_over: fail`. Run `ark test <run>`.
9. Invalid keys. For each of `slow_test_s: 0`, `slow_test_s: -1`, `time_budget_s: "ten"`, `on_over: stop` and `on_over: ""`, run `ark test <run>`.

## Expected results

- Step 1: the first run exits 0 and warns. The second run exits 1 with `passed: false` and the marker count is still 1: the limits are read from the current `ark.yml`, not from the cache entry. The third run exits 0 with no warning, marker count 1, and the stored entry was not changed to say `over`.
- Step 2: the run does not print `ok` for the slow check as if durations were known: it states that the reused suite has no durations (the validator pins the exact wording from the implementation), exits as it did before (0), does not fail the run in fail mode, and does not crash.
- Step 3: the quick run lists any test over `slow_test_s`, prints no suite budget verdict (a part of a suite has no suite time), exits as the same run without the keys would (a quick run is not a gate) and `test.completed` has `mode: "quick"` and the `passed` the keys-less run has.
- Step 4: the verdict reads the results after the retry: no slow line and exit 0 even with `on_over: fail`, because the second report replaced the first. The flaky line of the retry is unchanged.
- Step 5: exit 1 for the failing test, `passed: false`; the output names the failure and the time failure in separate lines; `failed_files` holds the failing test file and not a file for the time failure; the second run's pre-run runs the same files as the same run without the keys.
- Step 6: exit 1 with the time failure; `test.completed` has `failed_files` of `[]` (or absent, as a suite with no failing file has today) so the next run's pre-run does not re-run every file for a failure that names no file (a failure that names no file keeps every file of the pre-run); the second run exits 0 with the new `slow_test_s`.
- Step 7: no crash, no `NaN` and no slow line; the suite time is not printed as 0; the output says the report has no time. The result is the same as with no keys, in fail mode too (a missing time is not a time over).
- Step 8: the test with no case id is listed as slow (it has no entry, so it has no reason) and fails the run in fail mode; the test with a case id under 2 s is not listed.
- Step 9: each bad value exits 1 at load with a message that names the key and the allowed values (a positive number; `warn` or `fail`); no suite runs (the marker count stays 0).

## Screenshot checkpoints

none: CLI output and event-log case; no UI surface.
