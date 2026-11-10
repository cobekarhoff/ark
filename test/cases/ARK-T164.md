---
id: ARK-T164
title: "ARK-T164 a failed test file runs once more: a pass makes the suite pass and lists the file as flaky in the result, test.completed, the retro and the MR body; a second failure fails the suite"
level: integration
technique: equivalence classes (passes first time, fails then passes, fails twice) with boundary on the no-file fallback and the file in two suites
priority: high
risk: a real failure is retried until it passes, or never retried, or a second failure still passes; or the flaky list is lost between the result, the event, the retro, the MR body and a cached reuse, so a hidden race stays invisible
status: active
changed_by: 2026-11-09-ARK-366-1
---

## Objective

Prove that a failed file is retried exactly once, that a pass on retry passes the suite and is listed as flaky in every place, and that a second failure fails the suite.

## Preconditions

- Temporary `ARK_HOME` and git repo, a run with two suites: `flaky` has two files, `flaky.test` fails on its first start and passes on the second (a counter file decides) and `stable.test` always passes; `broken` has a file that always fails and a passing sibling `ok.test`. Every file appends a line to its own per-file counter file on each start, so starts are counted per file.
- A suite whose failed test has no `file` in the junit result, and a run with an open MR configured for `merge-request open` (the test double used by `test/merge-request.test.ts`).

## Steps

1. Run `ark test <run>` with only the `flaky` suite. Read the counter, the output, `results/`, the `test.completed` event and `ark status`.
2. Run `ark retro <run>` metrics and `ark merge-request open <run>` (body only) and read the flaky list in each.
3. Run `ark test <run>` again with nothing changed and read the output.
4. Run `ark test <run>` with only the `broken` suite and read the counter, the output and the exit code.
5. Run both suites together.
6. Run the suite with a failed test that has no `file`.
7. Put the same failing file name in two suites, one that passes on retry and one that fails twice.
8. Run a file whose failed test is skipped, or absent under that name, in the retry.

## Expected results

- Step 1: `flaky.test` starts exactly twice, not three times; `stable.test` starts exactly once (a whole-suite rerun would start it twice); the suite passes, exit 0; the output and the result list `flaky.test` (not `stable.test`) as flaky; `test.completed` carries the flaky field with that file.
- Step 2: the retro and the MR body list the file as flaky and say it failed once and passed on retry.
- Step 3: the suite is reused and the flaky list is still shown.
- Step 4: `broken` file starts exactly twice, its sibling `ok.test` exactly once, the suite fails and the exit code is 1; nothing is listed as flaky.
- Step 5: the run fails; the `flaky` suite is still listed as flaky and `broken` as failed.
- Step 6: the fallback in the plan applies and the output states it; the suite does not pass by skipping the failure.
- Step 7: the failure in the second suite is not hidden by the pass in the first.
- Step 8: the file starts exactly twice, the suite fails, nothing is listed as flaky: a retry passes only when every originally failed test is back and passed.

## Screenshot checkpoints

none: integration case on CLI output, files and processes; no UI surface.
