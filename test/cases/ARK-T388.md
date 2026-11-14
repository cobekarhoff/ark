---
id: ARK-T388
title: ARK-T388 ark test says no test title starts with the id after the criterion line of a test case that reads missing
level: integration
technique: equivalence classes of test case status (missing, failed, passed, not run) and of criterion source (verified_by vs tag), plus the quick-run split (case missing, criterion not run)
priority: high
risk: a criterion shows `missing via <id> missing` with no hint; or the hint is printed for a failed or passed case, for a case that reads `not run` (a skip that fills `headRun.skipped`), or for a tag-matched criterion that has no test case id; or the hint is missing on a quick run where the case reads `missing` although the criterion reads `not run`; or one hint is printed for a criterion with two missing cases instead of one for each; or a quick run whose suite ran only the own-commit files (`base_files`) prints `no test title starts with <id>` for a test that exists in a file it did not select
status: active
changed_by: 2026-11-13-ARK-333-1
---

## Objective

Prove that the hint follows the status of the test case, not of the criterion: for each test case in `verified_by` whose status reads `missing`, `ark test` prints `no test title starts with <test case id>` on a new line after the `criterion` line, and prints it for no case that reads `passed`, `failed` or `not run`, and for no tag-matched criterion.

## Preconditions

- The fake project of `test/test-run.test.ts` (`buildingRun`, real `ark` process).
- Ticket criteria: `AC1` verified_by `[FAKE-T1, FAKE-T2, FAKE-T3]`, where `FAKE-T1` has a passing test, and `FAKE-T2` and `FAKE-T3` have no test whose title starts with their id; `AC2` verified_by `[FAKE-T4]`, which has a failing test; `AC3` verified by tag only, with no test (status `missing via tag`).
- Three runs of this fixture, each with its own `ark test` process:
  - **Full**: `ark test <run>`. Cases read `FAKE-T1 passed`, `FAKE-T2 missing`, `FAKE-T3 missing`, `FAKE-T4 failed`.
  - **Quick, case missing**: `ark test <run> --quick` on the same fixture, whose suites have no `base_files`. A quick run of such a suite runs the whole suite and skips nothing (`cli/test-run.ts:1244-1256`), so `headRun.skipped` stays empty and `caseStatus` returns `missing` for `FAKE-T2` and `FAKE-T3`. Only the criterion reads `not run`, through `quickStatus`: the `via` text keeps `FAKE-T2 missing`.
  - **Skipped, case not run**: `ark test <run> --quick` on the fixture built with `selectiveBase: true` (each suite has `base_files: nomatch/*.test.ts` and a `base_command`) and no own commit that changes a test file, so each suite is skipped with `no changed test file` and `headRun.skipped` is not empty (`cli/test-run.ts:1250-1253`). `caseStatus` then returns `not run` for every case with no result, and the `via` text reads `FAKE-T2 not run`.
- **Quick, file selection**: a fixture whose e2e suite has `base_files: e2e.test.ts` and a `base_command` with `{files}`, and whose full command runs `./e2e.test.ts` and `./other.test.ts`. `AC1` verified_by `[FAKE-T1]`; `FAKE-T1` passes in `other.test.ts`. One own commit changes `e2e.test.ts` and adds `other.test.ts`. A quick run of this suite runs only the own-commit files that match `base_files`, so it runs `e2e.test.ts` and not `other.test.ts` (`cli/test-run.ts:1246-1260`, `ownTestFiles`). Nothing is skipped, so `headRun.skipped` stays empty and `caseStatus` returns `missing` for `FAKE-T1`, although the test exists.
- The skip of the ARK-T323 fixture (`repo not in run`) is **not** this third run: that skip never enters `headRun.skipped` (`cli/test-run.ts:1234-1237`), so its case reads `missing`.

## Steps

1. Run the **full** run. Split stdout into lines.
2. Find the `criterion  FAKE-1/AC1` line. Assert it still contains `via FAKE-T1 passed, FAKE-T2 missing, FAKE-T3 missing`.
3. Assert the lines after it, before the next `criterion` line, are `no test title starts with FAKE-T2` and `no test title starts with FAKE-T3`: one for each missing case, none for `FAKE-T1`.
4. Assert the `criterion  FAKE-1/AC2` line (case failed) is followed by no `no test title starts with` line.
5. Assert the `criterion  FAKE-1/AC3  missing  via tag` line is followed by no `no test title starts with` line.
6. Run the **quick, case missing** run. Assert the `criterion  FAKE-1/AC1` line reads `not run` and still holds `FAKE-T2 missing, FAKE-T3 missing`, and that both hint lines follow it, as in step 3 (the hint follows the case status, not the criterion status). Assert `FAKE-T4` (failed, a failure stays) has no hint.
7. Run the **skipped, case not run** run. Assert the `criterion  FAKE-1/AC1` line reads `not run` and holds `FAKE-T2 not run`, and that no `no test title starts with` line is in the whole stdout.

8. Run the **quick, file selection** run, then the full run of the same fixture. Assert the quick `criterion  FAKE-1/AC1` line reads `not run` and holds `via FAKE-T1 missing`, and that no `no test title starts with` line is in the whole stdout (a head suite ran with a file selection, so `missing` is not proven). Assert the full run reads `criterion  FAKE-1/AC1  passing` with `via FAKE-T1 passed`.

## Expected results

- When a test case in `verified_by` has status `missing`, the system shall print `no test title starts with <test case id>` after the `criterion` line of its criterion, one line for each such case, also on a quick run where the criterion reads `not run`.
- When the case reads `passed` or `failed`, or reads `not run` because a skipped suite filled `headRun.skipped`, the system shall print no hint.
- When the criterion is matched by tag (no test case id), the system shall print no hint and keep the `via tag` line unchanged.
- When a quick run of a suite with `base_files` runs only the own-commit files, the system shall print no hint, keep `via <test case id> missing` and the criterion status as they are, and read `via <test case id> passed` on the full run.
- The system shall keep every `criterion  <id>  <status>  via ...` line as it is today.

## Screenshot checkpoints

none: CLI output case; no UI surface.
