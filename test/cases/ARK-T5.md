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

- Fake project; the suite's configured command in the fixture config is the literal `bun test test/suite.test.ts --reporter=junit --reporter-outfile={report}`. The fixture knows the report path it expects (`<run folder>/results/<suite>-<checkout>.xml`, taken from the fixture layout/the files that appear on disk). Expected first line = that configured string with `{report}` replaced by that path, built by the test from the fixture config and the on-disk report file, not read from runner output or log.
- Two cases in one suite: `FAKE-T1` (fails at base, passes at head) and `FAKE-T2` (passes both), neither takes a screenshot. The suite prints `MARK-HEAD` or `MARK-BASE` depending on checkout (chosen by comparing `git rev-parse HEAD` to the fixture's base SHA).
- Base suite exit code 1; head suite exit code 0.
- Second fixture where the head suite exits 2; third where the base suite exits 0 and head exits 1.

## Steps

1. Run `ark test`.
2. Read `FAKE-T1/head/command.log` and `FAKE-T1/base/command.log`; split on `\n`.
3. Assert line 1 equals the expected command computed in Preconditions (head and base each with their own report path); assert a `MARK-HEAD` line (head) or `MARK-BASE` line (base) lies between line 1 and the last line; assert last line is `exit 0` for head and `exit 1` for base.
4. Read `FAKE-T2/head/command.log` and `FAKE-T2/base/command.log`; assert each byte-identical to FAKE-T1's log of the same checkout.
5. Assert head logs do not contain `MARK-BASE` and base logs do not contain `MARK-HEAD`.
6. Run the exit-2 fixture; assert head last line is exactly `exit 2` and nothing follows it (file ends right after it, optionally one newline).
7. Run the third fixture; assert base last line `exit 0` and head last line `exit 1`.

## Expected results

- When `ark test` runs a suite, the system shall write `command.log` with the command, the output and the exit code to the `base/` and `head/` folder of every case of that suite, including cases that take no screenshot.
- The first line of `command.log` shall be the configured suite command with `{report}` replaced by the report path used; the last line shall be `exit <code>` with the real exit code of the command (`exit 0`, `exit 1`, `exit 2` as exercised).
- Where several cases belong to one suite, the system shall write the same `command.log` content to each of them.
- The output between first and last line shall come from the checkout named by the folder.

## Screenshot checkpoints

none: integration case on log files; no UI surface.
