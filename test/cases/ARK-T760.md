---
id: ARK-T760
title: "ARK-T760 a Playwright suite whose failed tests pass on one rerun by title passes: the failed titles run again in one Playwright process, a passing sibling does not, and each title is listed as flaky in the output, test.completed, the retro and the MR body"
level: integration
technique: state transition (failed, then rerun by title, then passed) with equivalence classes (failed title, passing sibling in the same spec file)
priority: high
risk: "a failed Playwright test is never retried, because its JUnit report names no `file`, so one timing failure fails the whole suite; or the rerun starts the whole suite (the passing sibling starts twice), or one Playwright process for each title; or the suite still fails because Playwright's first exit code was non-zero; or a flaky title is dropped by a reader of the flaky list (the console line, `test.completed`, `metrics.json`, the MR body)"
status: active
changed_by: 2026-11-21-ARK-509-1
---

## Objective

Prove that when a Playwright suite fails and every failed test passes when it runs again by its title, `ark test <run>` passes the suite, reruns only the failed titles and all of them in one Playwright process, and reports each of those titles as flaky in every place where a flaky file is reported.

## Preconditions

- A temp `ARK_HOME`, a git repo and a run, as in the fixture of ARK-T164 (`test/detached-runner.test.ts`, `makeFixture` with `forge: true`, so `ark merge-request open` uses the fake host of `test/merge-request.test.ts`). The run commits one plain file, as ARK-T164's run commits its test files, so the run has a commit. The real `ark` process runs. Nothing in the runner, the parser or Playwright is mocked.
- One suite `pw` (level `e2e`, parser `bun`, as the project's `playwright` suite, with `base_files: test/pw/**/*.pw.ts`, which the config requires with `base_command`) that runs this repo's Playwright 1.64.1 by the absolute path of its binary, `<repo>/node_modules/.bin/playwright`, never through `bunx` (from the fixture repo, which has no `node_modules`, `bunx` downloads another version). Its JUnit reporter writes the report. A small Playwright config of its own imports only `defineConfig` from `@playwright/test` (it does not import the repo `playwright.config.ts`, unlike the config at `test/test-run.test.ts:1545`) and sets `testMatch: "**/*.pw.ts"`, one worker, no retries and a `testDir` that holds the specs below.
  - `command`: a side prefix, then `PLAYWRIGHT_JUNIT_OUTPUT_FILE={report} <repo>/node_modules/.bin/playwright test --reporter=junit --config <config>`.
  - `base_command`: the same, followed by ` {files}`, as in the project `ark.yml`. It holds the text `playwright test`, which is how S1 recognizes a Playwright suite.
  - The side prefix applies the side rule of `count.sh` in ARK-T164: the side is `base` when `$PWD` holds `ark-base-`, `census` when `{report}` holds `/census/`, and `head` otherwise. It appends one line to `invocations` only on the head side and exports the side to Playwright as `PW_SIDE`. The run commits no file that `base_files` matches, so the base run skips the suite; a start of `command` at base or in the census would write no line.
- Specs. They live in the fixture folder, outside the git repo, so no committed file holds them, and no title holds a case id (the ARK-431 plan-membership scan has nothing to read). On each start where `PW_SIDE` is `head`, each test appends one line to a counter file of its own, so starts are counted per test at head only:
  - `first.pw.ts`: `test("first flake", …)` fails on its first head start and passes after it; `test("stable sibling", …)` always passes.
  - `second.pw.ts`: `test("second flake", …)` fails on its first head start and passes after it.
  - No title is a substring of another title, so a correct rerun starts no other test.
- The report is the real Playwright JUnit shape: `<testcase name=… classname="first.pw.ts">` with no `file` attribute. A hand-written report with `file=` would take the file path and hide the gap.
- The expected names are the `name` attributes of the two failed `testcase` elements in `results/pw.report` (the first report, on disk). The test reads them from that file and never takes them from the code under test.

## Steps

1. Run `ark test <run>`. Capture stdout, stderr and the exit code.
2. Read `invocations`, the three counter files and `results/pw.report`, and take the names of its two failed testcases.
3. Read the last `test.completed` event in `events.ndjson`.
4. Run `ark retro <run>` and read `tests.flaky_files` in `metrics.json`.
5. Write the evidence of the run's AC and run `ark merge-request open <run>`; read the body that the fake host received.

## Expected results

- Step 1: exit 0, and stderr has no `suite pw failed`. The `suite      pw (e2e)  passed` line holds `flaky:`, each of the two report names and `(failed once, passed on retry)`. The output has no `not retried` line for `pw`.
- Step 2: `invocations` has exactly 2 head lines: the suite, then one retry for both titles. `first flake` and `second flake` each start exactly twice at head. `stable sibling` starts exactly once at head: a whole-suite or whole-file rerun starts it twice.
- Step 3: `passed` is `true`. The `pw` suite row has `passed: true` and no `failed_files`. The event's `flaky` list holds `{ suite: "pw", file: <name> }` for each of the two report names (in any order) and nothing for `stable sibling`.
- Step 4: `tests.flaky_files` holds `pw: <name>` for each of the two names.
- Step 5: the body names each of the two report names and the suite `pw` in its flaky lines, and says they failed once and passed on retry.

## Screenshot checkpoints

none: an integration case on CLI output, run files and processes; no UI surface.
