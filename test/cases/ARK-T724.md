---
id: ARK-T724
title: ARK-T724 a full ark test goes on with the normal suites after the pre-run files pass, and starts no pre-run when there is nothing to run, with --keep-going, for a suite without base_command, or for a failed file that no longer exists
level: integration
technique: decision table over the six skip conditions (no earlier test.completed, last one passed, last one with no failed files or written before this ticket, suite without base_command, --keep-going, file gone at head) plus the one positive row (files now pass)
priority: high
risk: the pre-run starts when it must not (an empty file list runs the whole suite as the pre-run, a missing file is passed to the base command and fails it, a suite without base_command is run, --keep-going does not skip it, an event written before this ticket fails the reader); the files pass and the run still stops or skips the normal suites or the base run; or the pre-run adds its results to the head run (double counted `passed_count`, a second `resources.json` row for the suite) or stores a cache entry that the normal suite then reuses
status: active
changed_by: 2026-11-20-ARK-551-1
---

## Objective

Prove the pre-run runs only when it has files to run, that it hands over to the normal full run when the files pass without a trace in the head run, and that each skip case starts no pre-run. Serves ARK-551/AC4. This case owns the hand-over run; ARK-T723 owns the stop.

Expected: When the failed files now pass, `ark test` shall go on with the normal suites in the same run; in each skip case it shall run the normal suites with no pre-run command.

## Preconditions

- The fixture project of ARK-T723 (suite `a` with `base_command` and `{files}`, a command log of every suite argv), where `fails-a.test.ts` and `fails-b.test.ts` now pass.
- For each row below, a fixture run whose `events.ndjson` holds the last `test.completed` written by hand or by a real earlier run.
- A suite `c` with no `base_command` and a failed file listed for it in the last event.

## Steps

Run a full `ark test <run>` once for each row. Read the exit code and the command log of that run only.

1. Positive: the last event is `passed: false` with `failed_files: [fails-a.test.ts]` for suite `a` and `[fails-b.test.ts]` for suite `b`, and both files now pass. After the run read the whole command log of that run (head, base and census lines), the new `test.completed` event (`passed_count`, the suite names and their `failed_files`) and `resources.json` of the run. Then run `ark test <run>` once more and read its output and its command log.
2. No earlier `test.completed` in the run.
3. The last `test.completed` has `passed: true`.
4. The last has `passed: false` and a suite entry with no `failed_files` (an event written before this ticket), and an entry with `failed_files: []`.
5. The last event of a failed check stop (`suites: []`).
6. The failed files are listed for suite `c` (no `base_command`).
7. The last event lists failed files and `--keep-going` is set. `ark test` reaches the pre-run through the one detached runner, so this is one run of the real command; a caller whose `--keep-going` differs from the live runner's attaches, prints one line to stderr and follows the runner under the runner's flag (`cli/test-runner.ts:290-295`, `docs/reference/cli.md`), so it starts no run of its own, and no step here runs it.
8. The last event lists gone files that no longer exist at head: `gone-a.test.ts` alone in suite `a`, and `gone-b.test.ts` next to `fails-b.test.ts` (which does exist) in suite `b`.
9. A passing `--quick` run is the last event after a failed full run.

## Expected results

- Step 1: the head log shows the `base_command` of suite `a` with `fails-a.test.ts` and then that of suite `b` with `fails-b.test.ts`, first and before any normal command, then the normal head commands of suite `a`, suite `b` and suite `c`; exit 0, and the output has no `the files of the last test still fail` line. The base run follows: the log holds `a files base`, `b files base` and `c normal base` (as a normal full run runs them, compared as a set), so the pre-run did not replace the base run. `passed_count` is 3: each test counts once, and a pre-run that added its results to the head run would give 5. The event lists suites `a`, `b` and `c` with no `failed_files`. `resources.json` has one row for each of the three suites and a `head` entry for `a`, and no extra row for a pre-run. The pre-run stored no cache entry of its own: the normal suite `a` run is not printed as `reused`, and the next full run prints `reused` and runs no head command again. The evidence of the head run is not read.
- Steps 2 to 6: the log shows no pre-run command (no suite run with a file list); the normal suites run as before. Step 5 reads the event without error. Step 6 runs no command for suite `c` as a pre-run.
- Step 7: no pre-run command (the run is one `--keep-going` run); the normal suites run and the exit code is 0.
- Step 8: when all failed files of a suite are gone (suite `a`), no command runs for it as a pre-run (not the whole suite, not an empty file list); next to a live file (suite `b`), the command holds only `fails-b.test.ts` (`b files head test/fails-b.test.ts`), and the normal suites follow.
- Step 9: the pre-run follows the ticket text "the last `test.completed` event of the run": a passing quick run is the last event, so no pre-run starts. The case fails if the reader skips quick events without a ticket change.
- No row gives an error from a suite entry without `failed_files`.

## Screenshot checkpoints

None. The surface is CLI output and the command log; no screenshot applies.
