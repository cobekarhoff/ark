---
id: ARK-T100
title: ARK-T100 a test that spawns Playwright passes inside a bun test parallel worker
level: integration
technique: equivalence classes of execution mode (serial process vs parallel worker) on one Playwright-spawning test
priority: high
risk: bun test --parallel workers set a Jest-style worker variable that a child Playwright run inherits and refuses ("excluded from Jest test runs"), so every Playwright-spawning test passes serially and fails in parallel; or the fix covers only one spawn site and another (ark test ui suite, checkpoint tests) still fails
status: active
changed_by: 2026-11-07-ARK-330-1
---

## Objective

Prove that tests which spawn a child Playwright run pass when `bun test` runs them in parallel workers, as they do serially, so `bun test --parallel` is usable as the `test` script, the pre-commit hook and the CI step.

## Preconditions

- Bun 1.4.0 or later with `--parallel`; real `bunx playwright`.
- An explicit file set of the Playwright-spawning test files: `test/playwright-migration.test.ts` and `test/evidence-test-run.test.ts` (the files that held the 9 parallel failures; it holds the ARK-T3 and ARK-T4 tests, which this case reuses as proof for the `playwrightRun()` and `uiRun()` spawn sites).
- The set never contains the file that owns this case's own test, so the child run cannot start the case again.
- No nested full `bun test` run: the case runs only this selected set. The three full `bun test --parallel` runs of AC3 are validator evidence, outside this case.

## Steps

1. Run the selected files serially: `bun test <files>`. Record the exit code.
2. Run the same files in parallel: `bun test --parallel <files>`. Record the exit code and the output.
3. Search the parallel output for `needs to be invoked via 'npx playwright test'` and `excluded from Jest test runs`.
4. Confirm the `test` script in `package.json`, `.githooks/pre-commit` and the `bun test` step of `.github/workflows/ci.yml` each carry `--parallel` (inspection; AC3 text).

## Expected results

- When the Playwright-spawning files run serially, the system shall exit 0.
- When the same files run with `--parallel`, the system shall exit 0, with the same pass count and 0 fail.
- The parallel output shall not contain the Jest-exclusion message.
- The script, hook and CI step shall each run `bun test --parallel`.

## Screenshot checkpoints

none: integration case on exit codes and test output; the checkpoint screenshots taken by the Playwright specs are not asserted here.
