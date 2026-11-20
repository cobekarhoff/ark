---
id: ARK-T723
title: ARK-T723 a full ark test runs the files that failed in the last test first with the base_command and {files}, stops with exit 1 and one line for each suite when they still fail, and the next full run runs them again
level: integration
technique: state transition over three real ark test runs (full run fails, the pre-run stops, the pre-run stops again) over two suites that each hold failed files, with a decision table on the file result (unresolved, flaky, red on main)
priority: high
risk: the failed files are never recorded, or are recorded for flaky and red-on-main files so a file that fails at the tip of main stops every full run with exit 1; the stopped event keeps no per-suite failed files so the pre-run runs once and never again; the pre-run runs after another suite or after the base run, or the normal command of suite `b` runs between the two pre-runs; only the first suite gets a pre-run or a line; the pre-run uses the whole suite and not `base_command` with the files; a stop still runs a suite or the base run; no `test.completed` with `passed: false` is recorded; or `ark status`, `ark chief state` and `ark merge-request open` read the stopped event as a pass
status: active
changed_by: 2026-11-20-ARK-551-1
---

## Objective

Prove a full `ark test` whose last `test.completed` lists failed files in two suites runs those files first with the quick selection, stops with exit 1 while they fail, and keeps the failed files for the next run. Serves ARK-551/AC3. The hand-over after the files pass is owned by ARK-T724 step 1.

Expected: When a file still fails after the one retry, `ark test` shall print one line for each suite with the failed files, exit 1, run no other suite and no base run, and record `test.completed` with `passed: false` and the failed files.

## Preconditions

- A fixture project with an `ark.yml` of two suites, `a` first and `b` second. Each has a `base_command` that holds `{files}`; each suite command (normal and `base_command`) appends its argv to a log file (as `count.sh` of `test/detached-runner.test.ts` does).
- Suite `a` holds `fails-a.test.ts` (added in the run's diff, always fails). Suite `b` holds `fails-b.test.ts` (added in the run's diff, always fails), `red.test.ts` (untouched, also fails on the main commit: red on main) and `flaky.test.ts` (fails once, passes on the retry).
- A fixture run with a worktree, a fixture `ARK_HOME`, the test budget free.

## Steps

1. Run a full `ark test <run>` (no flags). Read exit code, the command log and the last `test.completed` event of `events.ndjson`.
2. Run a full `ark test <run>` again with the same files. Read exit code, stdout, stderr, the command log from the point before this run, the new `test.completed` event, the run folder (`results/`) and the staging folder.
3. Run a full `ark test <run>` a third time. Read the command log from the point before this run and the new `test.completed` event.
4. After Step 2, read `ark status <run>`, `ark chief state` and run `ark merge-request open <run>`.

## Expected results

- Step 1: exit 1 (both suites fail). The event holds `failed_files` for suite `a`: `fails-a.test.ts` only, and for suite `b`: `fails-b.test.ts` only. Neither list holds `flaky.test.ts` (resolved by the retry) or `red.test.ts` (red on main, not counted as failed).
- Step 2: the command log shows, in this order and with nothing between them: the `base_command` of suite `a` with `{files}` replaced by `fails-a.test.ts` (and its one retry), then the `base_command` of suite `b` with `fails-b.test.ts` only (and its one retry). After them: no normal command of suite `a` or `b`, no run of `flaky.test.ts` or `red.test.ts`, no base run. The run prints one line for suite `a` with `fails-a.test.ts` and one line for suite `b` with `fails-b.test.ts`, and exits 1. It records `test.completed` with `passed: false`, the heads, no suites run, and the failed files of both suites kept for the next run. Criteria of the stopped run are `missing`, as for a failed check. The staging folder is removed after the stop and `results/` keeps the last published evidence.
- Step 3: the same as Step 2: both pre-runs run again, because the stopped event kept the failed files of both suites (the pre-run does not run only once).
- Step 4: `ark status` shows the last test as not passed, `ark chief state` shows no passing test for the run, and `ark merge-request open` refuses with `the last test run did not pass`. These are the readers of `mode`, `passed` and `heads` that a new stopped event can change. The other readers of a stopped event with `suites: []` (hub run detail, retro, criteria evidence) are owned by the reused ARK-T665; this case does not repeat them.

## Screenshot checkpoints

None. The surface is CLI output and run files; no screenshot applies.
