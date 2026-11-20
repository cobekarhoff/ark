---
id: ARK-T724
title: ARK-T724 a full ark test goes on with the normal suites after the pre-run files pass, and starts no pre-run when there is nothing to run, with --keep-going, for a suite without base_command, or for a failed file that no longer exists
level: integration
technique: decision table over the six skip conditions (no earlier test.completed, last one passed, last one with no failed files or written before this ticket, suite without base_command, --keep-going, file gone at head) plus the one positive row (files now pass)
priority: high
risk: the pre-run starts when it must not (an empty file list runs the whole suite as the pre-run, a missing file is passed to the base command and fails it, a suite without base_command is run, --keep-going does not skip it, an event written before this ticket fails the reader), or the files pass and the run still stops or skips the normal suites
status: active
changed_by: 2026-11-20-ARK-551-1
---

## Objective

Prove the pre-run runs only when it has files to run, that it hands over to the normal full run when the files pass, and that each skip case starts no pre-run. Serves ARK-551/AC4.

Expected: When the failed files now pass, `ark test` shall go on with the normal suites in the same run; in each skip case it shall run the normal suites with no pre-run command.

## Preconditions

- The fixture project of ARK-T723 (suite `a` with `base_command` and `{files}`, a command log of every suite argv).
- For each row below, a fixture run whose `events.ndjson` holds the last `test.completed` written by hand or by a real earlier run.
- A suite `c` with no `base_command` and a failed file listed for it in the last event.

## Steps

Run a full `ark test <run>` once for each row. Read the exit code and the command log of that run only.

1. Positive: the last event is `passed: false` with `failed_files: [fails.test.ts]` for suite `a`, and the file now passes.
2. No earlier `test.completed` in the run.
3. The last `test.completed` has `passed: true`.
4. The last has `passed: false` and a suite entry with no `failed_files` (an event written before this ticket), and an entry with `failed_files: []`.
5. The last event of a failed check stop (`suites: []`).
6. The failed files are listed for suite `c` (no `base_command`).
7. The last event lists failed files and `--keep-going` is set, in a foreground run and with the detached runner (a caller whose flag differs from the running one still exits 1).
8. The last event lists `gone.test.ts` that no longer exists at head, alone in a suite, and next to `fails.test.ts` that does.
9. A passing `--quick` run is the last event after a failed full run.

## Expected results

- Step 1: the log shows the pre-run command with `{files}` for suite `a` first, then the normal commands of every suite and the base run; exit 0 when they pass.
- Steps 2 to 6: the log shows no pre-run command (no suite run with a file list); the normal suites run as before. Step 5 reads the event without error. Step 6 runs no command for suite `c` as a pre-run.
- Step 7: no pre-run command in either mode; the normal suites run.
- Step 8: when all failed files of a suite are gone, no command runs for it as a pre-run (not the whole suite, not an empty file list); next to a live file, the command holds only `fails.test.ts`.
- Step 9: the pre-run follows the ticket text "the last `test.completed` event of the run": a passing quick run is the last event, so no pre-run starts. The case fails if the reader skips quick events without a ticket change.
- No row gives an error from a suite entry without `failed_files`.

## Screenshot checkpoints

None. The surface is CLI output and the command log; no screenshot applies.
