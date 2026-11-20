---
id: ARK-T723
title: ARK-T723 a full ark test runs the files that failed in the last test first with the base_command and {files}, stops with exit 1 and one line for each suite when they still fail, and the next full run runs them again
level: integration
technique: state transition over three real ark test runs (full run fails, the pre-run stops, the pre-run runs again), with a decision table on the file result (unresolved, flaky, red on main)
priority: high
risk: the failed files are never recorded or are recorded for flaky and red-on-main files so a file that fails at the tip of main stops every full run with exit 1, the stopped event writes `suites: []` with no per-suite failed files so the pre-run runs once and never again, the pre-run runs after another suite or after the base run, the pre-run uses the whole suite and not `base_command` with the files, a stop still runs a suite or the base run, the pre-run adds its results to the head run (double counted `passed_count`, evidence of test cases) or stores a cache entry, or no `test.completed` with `passed: false` is recorded
status: active
changed_by: 2026-11-20-ARK-551-1
---

## Objective

Prove a full `ark test` whose last `test.completed` lists failed files runs those files first with the quick selection, stops with exit 1 while they fail, and keeps the failed files for the next run. Serves ARK-551/AC3.

Expected: When a file still fails after the one retry, `ark test` shall print one line for each suite with the failed files, exit 1, run no other suite and no base run, and record `test.completed` with `passed: false` and the failed files.

## Preconditions

- A fixture project with an `ark.yml` of two suites: `a` with a `base_command` that holds `{files}` and a test file `fails.test.ts` that always fails, and `b` with a `base_command` and a passing file. Each suite command appends its argv to a log file (as `count.sh` of `test/detached-runner.test.ts` does).
- A fixture run with a worktree, `ARK_HOME` fixture, the test budget free.
- A second file `red.test.ts` in suite `b` that also fails on the main commit (red on main), and a flaky file `flaky.test.ts` that fails once and passes on the retry.

## Steps

1. Run a full `ark test <run>` (no flags). Read exit code, the command log and the last `test.completed` event of `events.ndjson`.
2. Run a full `ark test <run>` again with the same files. Read exit code, stdout, stderr, the command log from the point before this run, the new `test.completed` event, and the run folder (`results/`).
3. Run a full `ark test <run>` a third time. Read the command log from the point before this run and the new `test.completed` event.
4. Make `fails.test.ts` pass and run a full `ark test <run>` a fourth time.
5. Read `resources.json` of the run, `passed_count` of the head run and the cache folder after Step 2.
6. Read every reader of the stopped event: `ark status`, `ark chief state` and the evidence of the criteria after Step 2.

## Expected results

- Step 1: exit 1 (suite `a` fails). The event holds `failed_files` for suite `a`: `fails.test.ts` only; not `flaky.test.ts` (resolved) and not `red.test.ts` (red on main, not counted as failed).
- Step 2: the command log shows, first, one run of suite `a` with `base_command` and `{files}` replaced by `fails.test.ts` (and its one retry), and nothing after it: no run of suite `b`, no base run, no full command of any suite. The run prints one line for suite `a` with `fails.test.ts` and exits 1. It records `test.completed` with `passed: false`, the heads, no suites run, and a per-suite entry (name and `failed_files`) for suite `a`. Criteria of the stopped run are `missing`, as for a failed check.
- Step 3: the same as Step 2: the pre-run runs again, because the stopped event kept the failed files (the pre-run does not run only once).
- Step 4: the pre-run command runs with the file, passes, and the same run goes on with suite `a` and `b` and the base run as in a normal full run. `red.test.ts` never triggers a pre-run.
- Step 5: the pre-run adds nothing to `passed_count` or to the evidence of the head run, stores no cache entry and leaves a suite entry of `resources.json` that says the suite was a pre-run or none, never a second row for suite `a`; the staging folder is removed after the stop.
- Step 6: `ark status`, `ark chief state` and the criteria read the stopped event as the one of a failed check (no suite failing, `missing` criteria) and keep the last good evidence and heads.

## Screenshot checkpoints

None. The surface is CLI output and run files; no screenshot applies.
