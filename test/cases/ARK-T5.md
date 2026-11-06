---
id: ARK-T5
title: ARK-T5 command.log has the command, the output and the exit line
level: integration
technique: structure check of three parts, passing and failing exit codes
priority: medium
risk: command.log missing for a case that takes no screenshot, wrong first line, output of another suite, or exit code not the real one; cases of one suite not sharing the same log
status: active
changed_by: 2026-11-06-ARK-312-1
---

## Objective

Prove each case folder holds `command.log` laid out as: first line the suite command, then the checkout's output, last line `exit <code>`.

## Preconditions

- Fake project; suite command known (configured string, e.g. `bun test test --reporter=junit --reporter-outfile={report}`). The first line rule: the command as configured with `{report}` replaced by the path actually used; the test asserts the line starts with the executable and contains the suite's name argument, and matches the command string the runner reports.
- Two cases in one suite: `FAKE-T1` (fails at base, passes at head) and `FAKE-T2` (passes both), neither takes a screenshot. The suite prints a marker line `MARK-HEAD` / `MARK-BASE` depending on checkout.
- Base suite exit code 1; head suite exit code 0.

## Steps

1. Run `ark test`.
2. Read `FAKE-T1/head/command.log`, `FAKE-T1/base/command.log`.
3. Split lines. Assert line 1 equals the suite command, the marker is in the middle, the last line is `exit 0` for head and `exit 1` for base.
4. Read `FAKE-T2/head/command.log` and `FAKE-T2/base/command.log`; assert each is byte-identical to the log of FAKE-T1 in the same checkout (shared per suite).
5. Run a fixture where the suite exits 2 at head; assert last line `exit 2` and that no extra text follows it.
6. Assert the output of the head checkout does not contain `MARK-BASE` and vice versa.

## Expected results

- When `ark test` runs a suite, the system shall write `command.log` with the command, the output and the exit code to the `base/` and `head/` folder of every case of that suite.
- The first line of `command.log` shall be the suite command; the last line shall be `exit <code>` with the real exit code of the command.
- Where several cases belong to one suite, the system shall write the same `command.log` content to each of them.

## Screenshot checkpoints

none: integration case on log files; no UI surface.
