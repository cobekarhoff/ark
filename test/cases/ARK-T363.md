---
id: ARK-T363
title: ARK-T363 the MR body holds evidence blocks and screenshots only for the plan's test cases, though results/evidence/ holds the whole suite
level: integration
technique: equivalence classes (case named by the plan / case not named; plan names cases / plan names none / plan cases field absent from the ledger) on a large set, with a count as the observable
priority: high
risk: the body gets one evidence block for every folder of results/evidence/ (322 in ARK-427), so it passes GitHub's 65,536 limit and open refuses; or the five screenshots shown come from cases the plan does not name; or the AC evidence files are dropped with the filter; or a ledger with no `planCases` field loses every block, so the MR has no evidence and EVID04 fails
status: active
changed_by: 2026-11-13-ARK-446-1
---

## Objective

Prove that `buildBody` on a run whose `results/evidence/` holds a folder for each of 300 test cases, with a plan that names three of them, writes one evidence block for each of the three and none for the other 297, and shows screenshots only from those three.

## Preconditions

- A real run folder built in a scratch folder: `results/evidence/ARK-T1` to `ARK-T300`, each with `head/result.json` and `head/command.log`, and a `head/screenshots/` file for every case.
- A `plan.yml` whose `test_cases` name three of them (for example ARK-T7, ARK-T150, ARK-T299).
- One AC evidence file `results/evidence/AC1.md`.
- Three variants of the run: one with no `plan.yml`; one with a ledger JSON saved before this change (no `planCases` field), read back as `gather` reads it; and one with a `plan.yml` whose `test_cases` is empty (`[]`), with the same 300 evidence folders (a full `ark test` writes a folder for every case of the suite even when the plan names none).
- The real ledger reader and `buildBody` from `skills/pr-writing/lib`. No mocks.

## Steps

1. Build the run folder above.
2. Read the ledger from it and build the body with `buildBody`.
3. Build the body again for the three variants.
4. For the empty-plan variant, also run lint check EVID04 on the body and the ledger.
5. Count the `<details>` blocks that name a test case, and list the test case ids and screenshot paths in the body.

## Expected results

- When the plan names three test cases, the body shall have one evidence block for each of the three.
- The body shall have no evidence block, no log tail and no screenshot path for any other of the 300 cases.
- Every screenshot shown shall come from one of the three plan cases.
- The AC evidence file `AC1.md` shall still have its block.
- The body shall be shorter than the 65,536-character limit.
- When the ledger has no `planCases` field (no `plan.yml`, or a ledger saved before this change), the system shall filter nothing: the body shall have one block for each evidence entry of the ledger, as before this change, and shall not drop every block.
- When the plan names no test case (`test_cases: []`) and `results/evidence/` holds the 300 folders, the body shall still have a `## Evidence` section. Body shape decided: the heading, no per-case `<details>` block, no log tail and no screenshot path, the `AC1.md` block, and the test lines; it shall not say "the run has no `results/evidence/`", which is false. The body shall be shorter than 65,536 characters.
- For that empty-plan body, EVID04 shall pass (not fail with "results/evidence/ exists and the body has no ## Evidence section"), with 0 screenshots named.

## Screenshot checkpoints

none: integration case on the text of a built body; the screenshots it counts are paths in that text.
