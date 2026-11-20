---
id: ARK-T134
title: ARK-T134 the bun parser keeps case ids, criteria, file, status and duration_s of each test
level: integration
technique: equivalence classes (case id only, old id only, both, neither, slash form; passed, failed and skipped) across three runners and a Playwright JUnit report
priority: medium
risk: a case or AC id in a test title is lost, so a test proves nothing; or a result loses its file, so base selection marks a case in a selected file as not run (or the reverse); or a failed or skipped JUnit test case reads as passed (or loses its status), so a failing test proves an AC; or the time of a test is dropped, so a slow test is never listed
status: active
changed_by: 2026-11-20-ARK-581-1
---

## Objective

Prove that parsing a real bun JUnit report returns, for each test, its case ids, its old AC ids, its repo-relative file and its time, that the pytest and behave parsers keep the file of each test too, and that parsing a Playwright JUnit report maps a `<failure>` to `failed` and a `<skipped>` to `skipped`. Serves ARK-389/AC1 and AC3 (the file picks the base run and the `not run` status) and ARK-581/AC1 (the time of each test is `duration_s`).

Expected: When a report is parsed, the system shall return the case ids, the old AC ids, the status and the time of each case, and its file when the report names it.

## Preconditions

- Real reports captured from the same five cases: bun `bun-report.xml`, pytest `pytest-cases-report.xml`, behave `behave-cases-report.json` (test/fixtures/parsers).
- Titles: `ARK-T12 case only`, `CLARA-12-AC1 old only`, `ARK-T13 CLARA-12-AC2 both`, `neither`, `ARK-9/AC1 slash`.
- A Playwright JUnit report, `test/fixtures/playwright/junit.xml`: three test cases in `ui.pw.ts` with the `time` attributes `0.5`, `0.4` and `0`: `ARK-901-AC1 passes & stays green` (no child), `ARK-901-AC2 fails with a message` (a `<failure>` child) and `ARK-901-AC3 is skipped` (a `<skipped>` child). A `<testcase>` of this report has no `file` attribute.

## Steps

1. Run `parseBun` on the bun report.
2. Run `parsePytest` on the pytest report and `parseBehave` on the behave report.
3. Collect the distinct `file` values of the pytest and behave results.
4. Run `parseBun` on the Playwright JUnit report.

## Expected results

- Step 1: five results; each has `cases`, `criteria`, `status: passed`, `duration_s` equal to the `time` attribute of its test case in the report and `file: a.test.ts` as the title says (`neither` has both lists empty).
- Step 2: the same five cases (behave also `@case:` prefix form) read into `cases` and `criteria`.
- Step 3: pytest gives `test_cases.py`; behave gives `features/cases.feature`.
- Step 4: three results and no more, with the statuses `passed`, `failed` and `skipped` in that order, the criteria `ARK-901-AC1`, `ARK-901-AC2` and `ARK-901-AC3`, no case id, `duration_s` 0.5, 0.4 and 0, and no `file`.
- The time of a pytest and a behave test is owned by ARK-T742 (step 7), which reads it through the real `ark test`.

## Screenshot checkpoints

none: integration case on parser output; no UI surface.
