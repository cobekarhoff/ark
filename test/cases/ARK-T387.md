---
id: ARK-T387
title: ARK-T387 ark test prints the exit code, the log path and the last 20 log lines of a failed suite
level: integration
technique: equivalence classes (failed suite vs passed suite) plus boundary values on the 20-line tail (line 20 from the end absent, line 19 present)
priority: high
risk: a failed suite prints only `suite <name> failed`, so the validator must `ls results/` and `cat` the log; or the tail is the first 20 lines, the wrong file, or any count other than 20 (19, 21 to 39 or the whole log); or the exit code is hard-coded, taken from another suite, or printed for a passed suite
status: active
changed_by: 2026-11-13-ARK-333-1
---

## Objective

Prove that when a suite fails, `ark test` prints, next to the `suite <name> (<level>)  failed` line, the suite's exit code, the run-relative path of its log under `results/`, and exactly the last 20 lines of that log, as a failed check does today, and prints none of it for a passed suite.

## Preconditions

- The fake project of `test/test-run.test.ts` (`buildingRun`, real `ark` process, no mocking of the runner or the parser).
- Suite `e2e` (parser `bun`, JUnit) has **no `base_command`**, so a failing file is not retried and nothing is appended to `results/e2e.log` after the suite command (a retry appends `retry <file>`, its command and its output, `cli/test-run.ts:503-512`, which would move the tail). It holds one failing test. Its command is `bun test --reporter=junit --reporter-outfile={report} ./e2e.test.ts; for i in $(seq 1 40); do echo out-$i >&2; done; exit 3`.
  - The markers go to stderr, and the log on disk is stdout followed by stderr (`cli/test-run.ts:497`), so the 40 markers are the last 40 lines of `results/e2e.log`: `out-1` to `out-40`, in order, after the `bun test` output. Line 20 from the end is `out-21`, line 21 from the end is `out-20`. Both are unique in the log.
  - The suite exit code (3) differs from the `bun test` exit code (1) and from any default.
- Suite `unit` passes (one passing test), with no marker lines.
- The expected tail is read from `results/e2e.log` on disk by the test, never from the code under test. Before it asserts, the test checks the precondition: the log has at least 41 lines, its last 40 are `out-1` to `out-40`, and no other line of the log equals `out-20` or `out-21`.

## Steps

1. Run `ark test <run>` on the fixture. Capture stdout, stderr and the exit code.
2. Read `<run folder>/results/e2e.log`. Take its last 20 lines (`out-21` to `out-40`) as the expected tail, and its 21st line from the end (`out-20`) as the boundary line.
3. Find the `suite      e2e (e2e)  failed` line in stdout.
4. Assert the exit code of the process is non-zero. Assert a line of stdout after the failed-suite line that is not a tail line holds `3` as a whole word (the exit code of the suite), and that no `unit` line holds it.
5. Assert stdout contains the path `results/e2e.log` (run-relative, not absolute).
6. Assert the tail has the exact count and the right end:
   - the 20 expected lines are in stdout as whole lines (leading whitespace trimmed, the layout is the implementer's), in order and contiguous: the slice of stdout lines from `out-21` to `out-40` is exactly those 20 lines;
   - the boundary line `out-20` is not a whole line of stdout (a tail of 21 or more lines fails here);
   - `out-40`, the last line of the log, is a whole line (a tail that stops early fails here), and `out-1` is not.
7. Assert the lines of the failed suite come next to the unchanged `suite      e2e (e2e)  failed` line, and that stderr still contains `suite e2e failed`.
8. Assert that no exit code, log path or log line is printed for the passed suite `unit` (no `results/unit.log` in stdout).

## Expected results

- When a suite fails, the system shall print its exit code, the path `results/<suite>.log` and the last 20 lines of that file, no more and no fewer, in stdout.
- The system shall print the exit code as the suite returned it (3 here), also where it differs from the `bun test` code.
- The system shall keep the `suite <name> (<level>)  failed` line and the `suite <name> failed` error text unchanged.
- When a suite passes, the system shall print none of the three parts.

## Screenshot checkpoints

none: CLI output case; no UI surface.
