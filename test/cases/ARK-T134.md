---
id: ARK-T134
title: ARK-T134 the bun parser reads case ids and old AC ids from the JUnit title and keeps the file of each case
level: integration
technique: equivalence classes (case id only, old id only, both, neither, slash form) across three runners
priority: medium
risk: a case or AC id in a test title is lost, so a test proves nothing; or a result loses its file, so base selection marks a case in a selected file as not run (or the reverse)
status: active
changed_by: 2026-11-08-ARK-389-1
---

## Objective

Prove that parsing a real bun JUnit report returns, for each test, its case ids, its old AC ids and its repo-relative file, and that the pytest and behave parsers keep the file of each test too. Serves ARK-389/AC1 and AC3 (the file picks the base run and the `not run` status).

Expected: When a JUnit report is parsed, the system shall return the case ids, the old AC ids and the file of each case.

## Preconditions

- Real reports captured from the same five cases: bun `bun-report.xml`, pytest `pytest-cases-report.xml`, behave `behave-cases-report.json` (test/fixtures/parsers).
- Titles: `ARK-T12 case only`, `CLARA-12-AC1 old only`, `ARK-T13 CLARA-12-AC2 both`, `neither`, `ARK-9/AC1 slash`.

## Steps

1. Run `parseBun` on the bun report.
2. Run `parsePytest` on the pytest report and `parseBehave` on the behave report.
3. Collect the distinct `file` values of the pytest and behave results.

## Expected results

- Step 1: five results; each has `cases`, `criteria` and `file: a.test.ts` as the title says (`neither` has both lists empty).
- Step 2: the same five cases (behave also `@case:` prefix form) read into `cases` and `criteria`.
- Step 3: pytest gives `test_cases.py`; behave gives `features/cases.feature`.

## Screenshot checkpoints

none: integration case on parser output; no UI surface.
