---
id: ARK-T63
title: ARK-T63 A refactor run with no method test AC is not refused for a failing base suite
level: integration
technique: state transition (base_passed false, then never recorded) for the no-test-AC class; the test-AC class is owned by ARK-T12
priority: high
risk: a refactor run with only inspection ACs and a failing or unrecorded base suite is refused by ark test or ark merge-request open and cannot be shipped
status: active
changed_by: 2026-11-07-ARK-351-1
---

## Objective

Prove that a `kind: refactor` run with no `method: test` AC is not refused by the base-pass rule, in both places that enforce it (`ark test` and `ark merge-request open`). Serves ARK-351/AC2.

The refusal of a refactor run that has a `method: test` AC and a failing base is owned by ARK-T12 (updated by this run to state that precondition); this case does not repeat it.

Expected: Where a refactor run has no `method: test` AC, the system shall not refuse with `refactor run: the suites fail at the base commit`.

## Preconditions

- A temporary `ARK_HOME` and project with a git repo, a base commit where the suites fail, a head commit where they pass, and a fake forge so `ark merge-request open` can run.
- Refactor run A: `kind: refactor`, all ACs `method: inspection`.
- The other merge-request gates are satisfied, so the base-pass rule is the only possible refusal.

## Steps

1. In run A, run `ark test`. Read the output and the exit code.
2. In run A, run `ark merge-request open`.
3. In a second state of run A where `ark test` never recorded `base_passed`, run `ark merge-request open`.

## Expected results

- Step 1: `ark test` does not list `refactor run: the suites fail at the base commit` among the problems; the failing base is not a problem; exit 0 (head passes).
- Step 2: `ark merge-request open` opens the MR; it does not refuse with the base-pass text.
- Step 3: the MR opens, because with no `method: test` AC the missing `base_passed` is not checked.

## Screenshot checkpoints

None. The surface is CLI output; no screenshot applies.
