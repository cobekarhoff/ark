---
id: ARK-T3
title: ARK-T3 checkpoint writes a PNG only when ARK_EVIDENCE_DIR is set
level: e2e
technique: decision table (variable set / unset) and per-test subfolder keying
priority: high
risk: checkpoint writes when the variable is unset, writes to the wrong path, overwrites across tests, or the failing spec turns the whole run red; ark test does not route per-suite output to the case folder
status: active
changed_by: 2026-11-06-ARK-312-1
---

## Objective

Prove `checkpoint(page, name)` from `test/pw/helpers.ts` writes `screenshots/<name>.png` under `ARK_EVIDENCE_DIR` and writes nothing without it, and that `ark test` moves the scratch output to `results/evidence/<case id>/{base,head}/screenshots/`.

## Preconditions

- Spec `test/pw/checkpoint.pw.ts` (suffix `.pw.ts`), title starting `ARK-T3`: it navigates to a trivial page, calls `checkpoint(page, "after-click")`, then asserts something false, wrapped in `test.fail()` so the file is an expected failure and `bunx playwright test <spec>` exits 0. The spec must not fail as a real failure when `ark test` runs Playwright at head.
- Temp dir `E` for evidence. Playwright config unchanged: `screenshot: "only-on-failure"` stays.
- Second test in the spec carrying two case ids in its title, and a third with none, to fix the rule: scratch subfolders are keyed by each case id in the title; a test with no case id writes to a subfolder keyed by its sanitized title and is dropped (not moved) after parsing.
- Chromium installed (existing Playwright setup).

## Steps

1. Run `ARK_EVIDENCE_DIR=E bunx playwright test test/pw/checkpoint.pw.ts`. Record exit code.
2. List files under `E`; assert `screenshots/after-click.png` exists under a per-test subfolder keyed by the case id `ARK-T3`, is a valid PNG (first 8 bytes `89 50 4E 47 0D 0A 1A 0A`) and non-empty.
3. Run the same command with `ARK_EVIDENCE_DIR` unset and a fresh working dir. Assert exit code 0 and that no `screenshots` folder or PNG was created by `checkpoint` (Playwright's own only-on-failure output under its test-results dir is excluded from the check; compare against a run that never calls checkpoint).
4. Run through `ark test` on a fake UI project with this spec. Assert the PNG sits at `results/evidence/ARK-T3/head/screenshots/after-click.png` and at the base folder, and the scratch dir for the suite no longer exists after the run.
5. Assert the multi-id and no-id tests follow the rule above.

## Expected results

- When `ARK_EVIDENCE_DIR` is set, `checkpoint` shall write `screenshots/<name>.png` under it.
- When `ARK_EVIDENCE_DIR` is not set, `checkpoint` shall write no file.
- When `ark test` runs a suite, the system shall set `ARK_EVIDENCE_DIR` to a per-suite scratch folder and, after parsing, move each test's screenshots to `results/evidence/<case id>/<base|head>/screenshots/`.
- When a Playwright test is marked `test.fail()` and its assertion fails, the system shall report the spec as passed and `bunx playwright test` shall exit 0.
- Where a test title holds several case ids, the system shall copy its screenshots to each of those cases.

## Screenshot checkpoints

- after-click: page state at the moment of the call, before the failing assertion. Stored as `screenshots/after-click.png`; the case asserts the file, not pixel content.
