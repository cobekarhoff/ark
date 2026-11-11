---
id: ARK-T231
title: ARK-T231 After a `--verified-by` amend, `ark test` proves the criterion with the renumbered case ids
level: integration
technique: state transition (renumber after the plan is approved) with a real `ark test` run; the old id's test is absent and the new id's test present
priority: high
risk: "`ark test` still reads the old ids (from plan.yml or the approved plan) and reports the criterion missing or proved by a case that no longer exists, so a renumbered run cannot reach merge or shows false proof"
status: active
changed_by: 2026-11-10-ARK-361-1
---

## Objective

Prove end to end that the amended list is the one `ark test` uses, with the plan still naming the old id. Serves ARK-361/AC3.

Expected: When a criterion's verified_by list is amended to new ids, the system shall judge that criterion by the tests of the new ids at `ark test`, with no `ark plan check` run after approval.

## Preconditions

- A temporary `ARK_HOME`, project and git repo with a `bun` suite whose command runs a real test file.
- A run past plan approval, in building; plan.yml names `ARK-T10` for AC1.
- `test/cases/ARK-T10.md` and `ARK-T20.md` active; one committed test file whose test title starts with `ARK-T20`; no test titled `ARK-T10`.

## Steps

1. Run `ark test <run>`; note AC1 (it is missing: no test carries ARK-T10).
2. Run `ark criteria amend <run> AC1 --verified-by ARK-T20 --reason "renumbered"`.
3. Commit nothing else; run `ark test <run>` again.
4. Make the ARK-T20 test fail, commit, run `ark test <run>` once more.

## Expected results

- Step 1: AC1 is missing.
- Step 3: AC1 is passing and its evidence names `ARK-T20`; `ark test` does not ask for `ark plan check` and the approval is still set.
- Step 4: AC1 is failing, from the ARK-T20 test.

## Screenshot checkpoints

none: CLI output assertions only
