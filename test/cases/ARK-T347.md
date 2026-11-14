---
id: ARK-T347
title: ARK-T347 ark test passes a run whose diff touches case ids that the plan lists, for each of the actions add, update, reuse and retire
level: integration
technique: equivalence classes over the action value (add, update, reuse, retire)
priority: high
risk: "the check filters on the action and rejects one action (for example retire or add); the check compares ids loosely and reports a listed id; a plan that lists every touched id still fails ark test"
status: active
changed_by: 2026-11-13-ARK-431-1
---

## Objective

Prove that a listed touched id passes, whatever its action.

Expected: When the `test_cases` of `plan.yml` list every case id that the diff touches, with any of the actions add, update, reuse and retire, `ark test <run>` shall pass the plan-membership check.

## Preconditions

- Fixture project, base commit and run as in ARK-T346, with a bun test file that holds four tests titled `ARK-T1`, `ARK-T2`, `ARK-T3` and `ARK-T4`.
- A `plan.yml` whose `test_cases` lists the four ids with the actions add, update, reuse and retire, one each.
- A head commit that edits the body of the four tests.

## Steps

1. Run `ark test <run>`; read its output, its exit code and the recorded checks.

## Expected results

- No line of the plan-membership check names an id or reports a failure; the check passes in the recorded checks.
- The exit code comes from the suite results and the old id check as before (0 for passing tests).

## Screenshot checkpoints

none: the surface is CLI output, which the test reads as text.
