---
id: ARK-T761
title: "ARK-T761 a Playwright test that fails again after its rerun by title stays failed: a title with regex characters inside a describe block is rerun once, a flaky title of the same retry is still flaky, the suite fails with exit 1 and the rerun under load says so; a title shared by two tests stays failed when one copy fails again; a rerun that exits non-zero outside every test fails the suite; a test in a tagged describe block is rerun; a Playwright suite that fails with no failed test is not rerun"
level: integration
technique: "equivalence classes (fails twice, fails once, passes; no failed test at all) with special characters in the title ( ( ) . : + / and the describe separator ` › `) and state transition (failed, retried, still failed)"
priority: high
risk: "the title is put into `--grep` as it is in the report: a ` › ` describe separator or an unescaped `(`, `)`, `+` or `.` makes the rerun match no test, Playwright exits non-zero with no tests, and the failure stands without a real rerun; or a second failure passes the suite; or a title is retried more than once; or the retry's non-zero exit drops the title that did pass (the outcome-code rule of the file retry, so nothing is flaky), or marks the whole suite passed; or `failed_files` names the flaky title or no title; or the title path skips the load wait and its note; or a Playwright suite that exits non-zero with no failed testcase (a `globalSetup` that throws) gets an empty `--grep` that matches every test, so the whole suite reruns, passes and hides the crash; or a title shared by two tests is called flaky because one copy passed, so `failed_files` is empty; or the rerun exit code is ignored, so a teardown error passes the suite; or a describe tag in the grep string stops the title from matching"
status: active
changed_by: 2026-11-21-ARK-509-1
---

## Objective

Prove that a Playwright test that fails again on its one rerun by title stays failed and fails the suite, that the rerun matches the test even when its title has regex characters, a describe title or a describe tag in front of it, that another title of the same rerun that passes is still reported as flaky, that a title shared by two tests is not flaky while one copy fails, that a rerun whose process exits non-zero outside every test fails the suite although its titles passed, and that a Playwright suite that fails with no failed test is not rerun at all.

## Preconditions

- The fixture of ARK-T760: a temp `ARK_HOME`, git repo and run, suite `pw` running this repo's Playwright 1.64.1 by the absolute path `<repo>/node_modules/.bin/playwright` with its JUnit reporter, `command` and `base_command` as in ARK-T760 (`base_command` ends in `{files}`), the side prefix that writes one `invocations` line for each head start only and exports `PW_SIDE`, a counter file for each test that counts head starts, specs in the fixture folder outside the git repo with no case id in a title, and the real report shape (no `file` attribute).
- `ark.yml` of the fixture has `test_budget_cores: 3`.
- Specs:
  - `broken.pw.ts`: `test.describe("group (retry) 9", () => { test("keeps failing: a.b + c/d", …) })` fails on every head start. Its report name is the describe title and the test title joined by `›`, and it holds `(`, `)`, `.`, `:`, `+` and `/`.
  - `mixed.pw.ts`: `test("flaky (once) 1.5: x+y/z", …)` fails on its first head start and passes after it; `test("stable sibling", …)` always passes.
- The environment of the `ark test` process has `ARK_FAKE_LOAD_ONE=50` (above the budget of 3) and `ARK_RETRY_LOAD_WAIT_S=1`, so a retry waits for at most 1 s and then runs under load. Admission ignores the 1-minute load in every config (ARK-T710), so only a retry sees it.
- The expected names are the `name` attributes of the two failed `testcase` elements of `results/pw.report` (the first report, on disk), read by the test.
- Steps 5 to 7 use a fresh fixture each, with no load environment (the preload's load of 0), and count head starts as above:
  - Step 5: `bad.pw.ts` and `good.pw.ts` both declare `test("shared title", …)`. `bad` fails on every head start and `good` always passes.
  - Step 6: one spec `test("flaky (once) 1.5: x+y/z", …)` that fails on its first head start and passes after it, and a `globalTeardown` that throws when `PW_SIDE` is `head`, so every start exits 1 although no testcase after the first fails. The report holds no error element for the teardown.
  - Step 7: `test.describe("tagged group", { tag: "@slow" }, () => { test("inner flake", …) })` where the test fails on its first head start and passes after it. Playwright greps `tagged group @slow inner flake` and the report names it `tagged group › inner flake`.
- Step 4 uses a fresh fixture of the same shape whose Playwright config adds a `globalSetup` that throws when `PW_SIDE` is `head`. With a throwing `globalSetup`, Playwright 1.64.1 exits 1 and its JUnit report holds `<testsuites … tests="0" failures="0" …>` and no `testcase`.

## Steps

1. Run `ark test <run>` to its end. Capture stdout, stderr and the exit code.
2. Read `invocations`, the three counter files and `results/pw.report`, and take the names of its two failed testcases: `<broken>` and `<flaky>`.
3. Read the last `test.completed` event.
4. No failed test: in the `globalSetup` fixture, with the same load environment, run `ark test <run>` to its end, then read `invocations`, the counter files and the last `test.completed` event.

5. Shared title: run `ark test <run>`, then read the counters, `results/pw.report`, the last `test.completed` event and stdout.
6. Teardown: run `ark test <run>`, then read `invocations`, the counter, the last `test.completed` event and stderr.
7. Tagged describe: run `ark test <run>`, then read `invocations`, the counter, `results/pw.report` and the last `test.completed` event.

## Expected results

- Step 1: exit 1. Stderr holds `suite pw failed` and the `suite      pw (e2e)  failed` line is in stdout. A line names `pw` and holds `under load`: the title retry waited for the load and ran when the wait ran out. The output has no `not retried` line for `pw`.
- Step 2: `invocations` has exactly 2 head lines (the suite, then one retry for both titles). `keeps failing: a.b + c/d` starts exactly twice at head. With only 1 start, the rerun matched no test (an unescaped or unsplit title), even though the suite still fails. `flaky (once) 1.5: x+y/z` starts exactly twice. `stable sibling` starts exactly once.
- Step 3: `passed` is `false`. The `pw` row has `passed: false` and `failed_files` equal to `[<broken>]`. The event's `flaky` list is `[{ suite: "pw", file: <flaky> }]`, and `<broken>` is in no flaky list. The output's `flaky:` text, if it is printed, names `<flaky>` and not `<broken>`.
- Step 4: exit 1, and stderr holds `suite pw failed`. `invocations` has exactly 1 head line: no rerun started. No test starts at head (every counter file is absent or empty). No line for `pw` says the retry waits for the load or holds `under load`. The event has `passed: false`, the `pw` row has `passed: false` and no `failed_files`, and the `flaky` list holds no `pw` entry. A rerun with an empty `--grep` (which matches every test) writes a second head line to `invocations` and, under the load of 50, the wait and `under load` lines; on a host where the crash does not repeat, that rerun would pass the suite and hide the crash.
- Step 5: exit 1 and stderr holds `suite pw failed`. The first report has one failed testcase, `shared title`. `bad` and `good` each start exactly twice at head (the rerun by title runs both copies). The event has `passed: false`, the `pw` row has `failed_files` equal to `["shared title"]`, the `flaky` list is empty and the output has no `flaky:` text. A rule that calls a title flaky when any copy passed lists it as flaky and leaves `failed_files` empty.
- Step 6: exit 1 and stderr holds `suite pw failed`. `invocations` has exactly 2 head lines, the counter holds 2 starts, `passed` is `false`, the `pw` row has `failed_files` equal to the report name, and the `flaky` list is empty. A rerun whose exit code is ignored passes the suite.
- Step 7: exit 0. The first report names the failed test `tagged group › inner flake`. `invocations` has 2 head lines, the counter holds 2 starts, and the `flaky` list is `[{ suite: "pw", file: "tagged group › inner flake" }]`. A `--grep` that joins the describe title and the test title with a plain space finds no test (`No tests found`), so the counter holds 1 start and the suite fails.

## Screenshot checkpoints

none: an integration case on CLI output, run files and processes; no UI surface.
