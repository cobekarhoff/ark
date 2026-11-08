---
id: ARK-T99
title: ARK-T99 one Playwright spec run with a scratch TMPDIR leaves the temporary folder empty
level: integration
technique: state transition (before run / after run) with a scratch folder as the observable
priority: medium
risk: the temp-folder check starts the whole Playwright suite (slow, 195 s), or a single-spec run leaves Playwright's transform cache or other files in TMPDIR because global teardown no longer cleans it, or the run fails and the check still passes
status: active
changed_by: 2026-11-07-ARK-330-1
---

## Objective

Prove that running one real Playwright spec with `TMPDIR` set to an empty scratch folder exits 0 and leaves that folder empty, without running the whole Playwright suite.

## Preconditions

- Real `bunx playwright` and the repo's `playwright.config.ts`, `test/pw/global-teardown.ts` and `test/pw/checkpoint.pw.ts`. No mocks.
- A fresh empty scratch folder under the host temp folder.

## Steps

1. Create the empty scratch folder.
2. Run `playwright test test/pw/checkpoint.pw.ts --reporter=line` in the repo root with `TMPDIR=<scratch>`.
3. Read the exit code and the output of the run.
4. List the scratch folder.
5. Remove the scratch folder.

## Expected results

- When one spec runs with a scratch `TMPDIR`, the system shall exit 0.
- The run shall execute only the tests of `test/pw/checkpoint.pw.ts` (the reported test count is that spec's count, not the 54 of the whole suite).
- After the run, the scratch folder shall be empty.
- `bun test test/playwright-migration.test.ts` shall exit 0, both serially and with `--parallel`, and no test in `test/` shall start the whole Playwright suite.

## Screenshot checkpoints

none: integration case on a process exit code and a folder listing; the screenshots belong to the Playwright spec itself.
