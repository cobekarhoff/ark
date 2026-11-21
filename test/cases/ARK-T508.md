---
id: ARK-T508
title: "ARK-T508 a bug run's plan check needs a first validator step that serves every test criterion, and accepts one that leaves an analysis, inspection or demonstration criterion to a later step"
level: integration
technique: "equivalence classes of the first step of a bug run (not a validator, a validator that misses a test criterion, a validator that serves every test criterion) crossed with the method of the criterion left to a later step (analysis, inspection, demonstration)"
priority: high
risk: "the narrowed rule loses a half: a bug run accepts a first validator that misses a `method: test` criterion, so the red proof runs without that criterion's failing test; or it still refuses a first validator that leaves only a non-test criterion to a later step, for one of the three methods (for example a filter that drops `analysis` only), so the run lead writes a placeholder evidence file again; or the refusal text changes and a reader of today's message breaks"
status: active
changed_by: 2026-11-21-ARK-619-1
---

## Objective

Prove that `ark plan check` of a bug run refuses a plan whose first step is not a validator, or is a validator that misses a criterion with `method: test`, with the line `bug run: the first step must be a validator step that serves every criterion`, and accepts a plan whose first validator serves every `method: test` criterion while an `analysis`, `inspection` or `demonstration` criterion is served only by a later step. Serves ARK-619/AC1. Production owner: `findProblems` in `cli/plan-check.ts`.

Authoring gate:

1. Protects: the first-step rule of a bug run in `ark plan check` (exit code and refusal line), for test and non-test criteria.
2. Fails when: the filter of the rule keeps a non-test criterion (the old rule: every criterion), drops a test criterion, names only one of the three non-test methods, or the refusal line changes.
3. Existing proof misses it: before ARK-619 this case had only `method: test` criteria, so the non-test half of the rule had no accept row. ARK-T509 owns the `manual: true` front matter key with no `method`; this case owns the `method` values.
4. No test-only export: the case runs the real `ark plan check` process on fixture files.

## Preconditions

- The fixture of the `plan check by ticket kind` block of `test/plan.test.ts`: a project, a recorded evaluation, and a bug run started with `ark run start` on a ticket of kind `bug` whose criteria the case names. Every plan is valid for every other rule of plan check (roles, needs, test cases), so only the bug-run rule can refuse it.
- Ticket T (`ARK-901`; refusal rows and the first accept row): `AC1` and `AC2`, both `method: test`.
- Ticket M, one per method `analysis`, `inspection` and `demonstration` (`ARK-910`, `ARK-911` and `ARK-912`, in that order): `AC1` and `AC2` with `method: test`, and `AC3` with that method.

## Steps

1. On ticket T, write each plan below, run `ark plan check <run>`, and read the exit code and the output:
   - the first step is an implementer step;
   - the first step is a validator that serves `AC1` only, a later implementer serves `AC1` only;
   - an implementer step serving `AC1` and `AC2` comes first and a validator serving both second.
2. On ticket T, write a plan whose first step is a validator serving `AC1` and `AC2`, then an implementer that needs it. Run plan check.
3. On each ticket M, write a plan whose first step is a validator serving `AC1` and `AC2` only, then an implementer that needs it and serves `AC1` and `AC2`, then a validator that needs the implementer and serves `AC3` (the step that writes the evidence after the fix). Run plan check.
4. On one ticket M, write the plan of step 3 with a first validator that serves `AC1` and `AC3` (it misses the test criterion `AC2`). Run plan check.

## Expected results

- Steps 1 and 4: exit 1, and the output holds the whole line `bug run: the first step must be a validator step that serves every criterion`.
- Step 2: exit 0.
- Step 3: exit 0 for each of `analysis`, `inspection` and `demonstration`, and no line that starts with `bug run`.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
