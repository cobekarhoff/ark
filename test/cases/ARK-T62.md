---
id: ARK-T62
title: ARK-T62 A bug run needs a red ark test only when it has a method test AC
level: integration
technique: equivalence classes on the AC methods of a bug run (all non-test, one test, mixed) and state transition (no ark test, ark test with AC passing, ark test with AC failing)
priority: high
risk: a bug run whose ACs are all inspection, analysis or demonstration is refused at the implementer start for ever and must be aborted, or a bug run with a method test AC starts without a red proof
status: active
changed_by: 2026-11-07-ARK-351-1
---

## Objective

Prove that the red-test rule of a `kind: bug` run applies only when the run has at least one `method: test` AC. Serves ARK-351/AC1.

Expected: Where a bug run has no `method: test` AC, the system shall start the implementer step with no failing `ark test`. Where it has one, the system shall refuse until one `ark test` shows every `method: test` AC failing.

## Preconditions

- A temporary `ARK_HOME` and project with a git repo and a test command, so `ark test` runs.
- Bug run A: `kind: bug`, three ACs, all `method: inspection` (the ARK-347 shape). A second variant A2 has one `analysis`, one `demonstration`, and one `manual: true` AC.
- Bug run B: `kind: bug`, two ACs: AC1 `method: test`, AC2 `method: inspection`.
- Bug run C: as B, then `criteria.amended` changes AC1 to `method: inspection` (current criteria have no test AC).
- Each run has a plan with an implementer step, started up to the planning gate.

## Steps

1. In run A, run `ark run step <run> <implementer step> start` with no `ark test` run. Repeat for A2.
2. In run B, run the same start with no `ark test` run. Read the error.
3. In run B, run `ark test` while the test of AC1 passes. Run the start again.
4. In run B, make the test of AC1 fail, run `ark test`, then run the start again.
5. In run C, run the start with no `ark test` run.

## Expected results

- Step 1: the start succeeds for A and A2; the step is `in_progress`; the text `bug run: record a failing ark test of the ACs before the fix` does not appear.
- Step 2: the start is refused with `bug run: record a failing ark test of the ACs before the fix`; the step does not start.
- Step 3: the start is still refused with the same text.
- Step 4: the start succeeds. Only AC1 (`method: test`) must fail; AC2 (inspection) is not needed.
- Step 5: the start succeeds, because the current criteria have no `method: test` AC.

## Screenshot checkpoints

None. The surface is CLI output; no screenshot applies.
