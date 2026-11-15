---
id: ARK-T664
title: ARK-T664 ark test runs no suite after a failed check and exits 1, and --keep-going runs the suites as before, in a full and a quick run
level: integration
technique: decision table (check failed or not, --keep-going or not, full or quick) with equivalence classes over the kind of check (config check, old-id, plan-membership) and a boundary on the position of the failed check (first of two)
priority: high
risk: "a failed check still starts the suites, so a 7-14 minute run is wasted (the ARK-481 defect); the stop skips the later checks so old-id and plan-membership are no longer recorded together; a stopped run exits 0 or does not name the failed check; --keep-going is parsed but never reaches the detached runner, so it still stops; --keep-going works in a full run and not in a quick run; the stop is applied to one kind of check only; a run with no failed check no longer runs its suites"
status: active
changed_by: 2026-11-14-ARK-481-1
---

## Objective

Prove that `ark test <run>` runs every check, and when one failed runs no suite and exits 1, naming each failed check; that `--keep-going` runs the suites as before; that both hold for `--quick`; and that a run with no failed check still runs its suites. Serves ARK-481/AC1.

Expected: When a check of `ark test <run>` fails and `--keep-going` is not set, the system shall run no suite, record `passed: false` with the failed checks in `test.completed`, print the failed check and exit 1. When `--keep-going` is set, the system shall run the suites as it did before.

## Preconditions

- Fixture of `test/test-run.test.ts`: `buildingRun` with one `FAKE-1-AC1` criterion verified by a passing e2e test, and the `checks` option built from `checkFixtures` (a passing check, and the failing check `lint-fail` that prints 25 lines and exits 1). `buildingRun` always configures two suites, `unit` and `e2e` (both parser `bun`), so a full run that reaches the suites records two suite entries.
- The `e2e` suite command (`e2eCommand`) also writes a marker file (`suite-ran`) outside the worktree; the `unit` suite writes none. A marker that is absent after a call proves that the `e2e` suite did not start, and the suite loop runs every suite, so no suite started; the output lines are not the proof. Every step that reads the marker starts on a fresh run, so the marker of an earlier call and the cache of a passed head suite (`cli/test-run.ts:1262-1286`, `reused`) cannot hide whether the call ran the suite.
- `ark test` is called as a person calls it, with no test hook: it runs through the detached runner.
- Variants for the other checks, built on the fixtures of `test/test-audit.test.ts`: one bun suite whose diff touches an old-id test title (old-id fails), and one whose diff touches a test with a case id that `plan.yml` does not list (plan-membership fails). Each has no failing `config.checks` entry.

## Steps

1. Checks `[passing, failing]`. Run `ark test <run>`. Read the output, the exit code, the marker file, the last `test.completed` and `results/check-lint-fail.log`.
2. Checks `[failing, passing]` (the failed check first). Run `ark test <run>`. Read the recorded checks.
3. Fresh run, checks `[passing, failing]`. Run `ark test <run> --keep-going`. Read the same things as in step 1.
4. Fresh run, checks `[passing, failing]`. Run `ark test <run> --quick`. Then run `ark test <run> --quick --keep-going` in another fresh run.
5. Two fresh runs, each with checks `[passing]` and no failed old-id or plan-membership check. In the first run `ark test <run>`; in the second `ark test <run> --keep-going`. Read the exit code, the marker and `test.completed` of each.
6. Old-id variant: run `ark test <run>`, then `ark test <run> --keep-going` in a fresh run. Plan-membership variant: the same two calls.
7. Fresh run, one check whose command does not exist (`no-such-tool-481`, exit 127). Run `ark test <run>`.

## Expected results

- Step 1: exit 1. The output holds `check lint-fail failed` and its last 20 lines (`out-6` to `out-25`). The run is stopped, so no output line starts with `suite ` (the `old id    suite unit (bun)` and `plan-membership` lines of the checks contain `suite ` but do not start with it) and no criterion line prints (no `FAKE-1/AC1  ...` line). The final throw lists only the failed checks: stderr is `ark: tests did not prove every criterion: check lint-fail failed` and a newline (the runner prints `ark: ` and the error message, `cli/test-runner.ts:212`), with no `FAKE-1/AC1 is missing` text. The marker file is absent: no suite ran. `test.completed` has `passed: false`, a `checks` entry for `in-worktree` (passed) and `lint-fail` (failed), and `suites: []`; the event still records the criterion as `missing` (ARK-T665 owns that shape). `results/check-lint-fail.log` holds the 25 lines.
- Step 2: the same as step 1, and the checks after the failed one ran too: the `test.completed` event holds the `in-worktree` (passed) entry after `lint-fail`, and the old-id and plan-membership entries of both suites, `old-id unit`, `old-id e2e`, `plan-membership unit` and `plan-membership e2e`, each passed. The stop came after every check.
- Step 3: exit 1 (the check still fails the run). The marker file exists, the output holds `FAKE-1/AC1  passing`, and `test.completed` has `passed: false`, the failed check, and two suite entries (`unit` and `e2e`). The final throw lists the failed check only: stderr is `ark: tests did not prove every criterion: check lint-fail failed` and a newline. This is the behavior of the base commit.
- Step 4: `--quick` alone: exit 1, no marker, `suites: []`. `--quick --keep-going`: exit 1, the marker exists, and both suite entries are present.
- Step 5 (control): exit 0 for both calls, the marker exists in each run, `passed` is true in each, and each event holds two suite entries.
- Step 6: the old-id variant and the plan-membership variant each print their existing `failed` line (`old id touched: ...` and the line that names the case id and the fix). Without `--keep-going` they run no suite (the marker is absent), print no criterion line and exit 1, with stderr `ark: tests did not prove every criterion: check old-id e2e failed` (old-id variant) or `ark: tests did not prove every criterion: check plan-membership e2e failed` (plan-membership variant) and a newline. With `--keep-going` the suites run and the exit code is 1.
- Step 7: exit 1, with `check no-such-tool-481 failed` in the output and in stderr; no marker. A check that cannot start is a failed check, not a crash.

## Screenshot checkpoints

none: the surface is CLI output, exit codes and files, which the test reads as text.
