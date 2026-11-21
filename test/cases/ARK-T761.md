---
id: ARK-T761
title: "ARK-T761 a Playwright test that fails again after its rerun by title stays failed: a title with regex characters inside a describe block is rerun once, a flaky title of the same retry is still flaky, the suite fails with exit 1 and the rerun under load says so"
level: integration
technique: equivalence classes (fails twice, fails once, passes) with special characters in the title ( ( ) . : + / and the describe separator ` › `) and state transition (failed, retried, still failed)
priority: high
risk: "the title is put into `--grep` as it is in the report: a ` › ` describe separator or an unescaped `(`, `)`, `+` or `.` makes the rerun match no test, Playwright exits non-zero with no tests, and the failure stands without a real rerun; or a second failure passes the suite; or a title is retried more than once; or the retry's non-zero exit drops the title that did pass (the outcome-code rule of the file retry, so nothing is flaky), or marks the whole suite passed; or `failed_files` names the flaky title or no title; or the title path skips the load wait and its note"
status: active
changed_by: 2026-11-21-ARK-509-1
---

## Objective

Prove that a Playwright test that fails again on its one rerun by title stays failed and fails the suite, that the rerun matches the test even when its title has regex characters and a describe title in front of it, and that another title of the same rerun that passes is still reported as flaky.

## Preconditions

- The fixture of ARK-T760: a temp `ARK_HOME`, git repo and run, suite `pw` running the real Playwright 1.64 with its JUnit reporter, `command` and `base_command` as in ARK-T760 (`base_command` ends in `{files}`), an `invocations` file that gets one line for each start, a counter file for each test that counts head starts, and the real report shape (no `file` attribute).
- `ark.yml` of the fixture has `test_budget_cores: 3` and no `test_max_load`.
- Specs:
  - `broken.pw.ts`: `test.describe("ARK-T9 (retry) group", () => { test("keeps failing: a.b + c/d", …) })` fails on every head start. Its report name is the describe title and the test title joined by `›`, and it holds `(`, `)`, `.`, `:`, `+` and `/`.
  - `mixed.pw.ts`: `test("flaky (once) 1.5: x+y/z", …)` fails on its first head start and passes after it; `test("stable sibling", …)` always passes.
- The environment of the `ark test` process has `ARK_FAKE_LOAD_ONE=50` (above the budget of 3) and `ARK_RETRY_LOAD_WAIT_S=1`, so the retry waits for at most 1 s and then runs under load. Admission ignores the 1-minute load when there is no `test_max_load` (ARK-T710), so only the retry sees it.
- The expected names are the `name` attributes of the two failed `testcase` elements of `results/pw.report` (the first report, on disk), read by the test.

## Steps

1. Run `ark test <run>` to its end. Capture stdout, stderr and the exit code.
2. Read `invocations`, the three counter files and `results/pw.report`, and take the names of its two failed testcases: `<broken>` and `<flaky>`.
3. Read the last `test.completed` event.

## Expected results

- Step 1: exit 1. Stderr holds `suite pw failed` and the `suite      pw (e2e)  failed` line is in stdout. A line names `pw` and holds `under load`: the title retry waited for the load and ran when the wait ran out. The output has no `not retried` line for `pw`.
- Step 2: `invocations` has exactly 2 lines (the suite, then one retry for both titles). `keeps failing: a.b + c/d` starts exactly twice at head. With only 1 start, the rerun matched no test (an unescaped or unsplit title), even though the suite still fails. `flaky (once) 1.5: x+y/z` starts exactly twice. `stable sibling` starts exactly once.
- Step 3: `passed` is `false`. The `pw` row has `passed: false` and `failed_files` equal to `[<broken>]`. The event's `flaky` list is `[{ suite: "pw", file: <flaky> }]`, and `<broken>` is in no flaky list. The output's `flaky:` text, if it is printed, names `<flaky>` and not `<broken>`.

## Screenshot checkpoints

none: an integration case on CLI output, run files and processes; no UI surface.
