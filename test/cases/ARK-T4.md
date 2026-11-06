---
id: ARK-T4
title: ARK-T4 UI case has the same checkpoint names at base and head
level: e2e
technique: state transition (feature absent at base, present at head) and equality of checkpoint name sets
priority: high
risk: base run keeps no checkpoint screenshot because the screenshot comes after the assertion, so base and head name sets differ; or a base UI failure fails ark test
status: active
changed_by: 2026-11-06-ARK-312-1
---

## Objective

Prove that for a UI case whose feature exists only at head, base `result.json` says failed, both `screenshots/` folders hold identical checkpoint names, and `ark test` exits 0.

## Preconditions

- Fake UI project: static page server in the spec. Base commit: page without the `#feature` element. Head commit: page with it.
- New Playwright spec `test/pw/feature.pw.ts`, title `FAKE-T9 shows feature`, calls `checkpoint(page, "opened")`, `await expect(locator("#feature")).toBeVisible()` after a `checkpoint(page, "feature-visible")` placed before that assertion. Not wrapped in `test.fail()`.
- Run `kind: feature`; the spec is copied from head into the base checkout (ARK-T1 rule).
- Chromium installed.

## Steps

1. Run `ark test` for the run.
2. Record the exit code.
3. Read `results/evidence/FAKE-T9/base/result.json` and `head/result.json`.
4. List `screenshots/` in both folders; sort names.
5. Assert each listed file is a valid PNG.
6. Run a variant where a checkpoint is placed after the failing assertion; assert the contract is violated detectably (base set is smaller), documenting why checkpoint-before-assertion is required.

## Expected results

- When a UI case fails at base, the system shall keep its checkpoint screenshots and `ark test` shall exit 0.
- The base `result.json` shall have status `failed` and the head `result.json` status `passed`.
- The sets of checkpoint names in base and head `screenshots/` shall be equal: `feature-visible.png` and `opened.png`.
- When a failing assertion follows a checkpoint call, the system shall already have written that checkpoint's PNG.

## Screenshot checkpoints

- opened: page loaded, both base and head.
- feature-visible: base shows the page without the feature; head shows it. Both PNGs required; the case compares names and PNG validity, not pixels.
