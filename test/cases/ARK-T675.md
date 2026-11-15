---
id: ARK-T675
title: ARK-T675 finishing an implementer step with a missing or invalid plan.yml, or a plan that lists no test_cases, prints a skip line and finishes
level: integration
technique: equivalence classes of plan state (missing file, invalid YAML, plan that loadPlan refuses, valid with no test_cases) with the diff held constant
priority: medium
risk: "implementer finish crashes or refuses when plan.yml is missing or invalid, so a human take_over implementer or a run with no plan can never finish; the skip is silent, so the run lead believes the plan was checked; a valid plan with no test_cases is treated as skipped and not as an empty set, so a touched id passes"
status: active
changed_by: 2026-11-14-ARK-496-1
---

## Objective

Prove that implementer finish skips the plan membership check, with a printed line, when it cannot read a plan. Serves ARK-496/AC1. A valid plan with an empty `test_cases` is not a skip: every touched id is missing.

Expected: When `plan.yml` is missing or invalid, the command shall print a line that says the plan-membership check was skipped, shall exit 0 and shall append `step.finished`; when `plan.yml` is valid and `test_cases` is empty, the command shall refuse for a touched case id.

## Preconditions

- The fixture of ARK-T671: a started implementer step whose commit edits the `ARK-T2` test.
- Variants of the run's `plan.yml`: A deleted; B not parseable YAML; C valid YAML that `loadPlan` refuses (a `test_cases` entry with the old `steps` field); D valid, with `test_cases: []`.
- A human `take_over` implementer run (`state.implementer === "human"`) with no `plan.yml`, for variant A.

## Steps

1. For each variant A to C, run `ark run step <run> <step> finish`; read exit code, output and events.
2. For variant D, run `finish`.

## Expected results

- A, B and C: exit 0, one printed line `plan-membership check  skipped  (<reason>)` (two spaces around `skipped`, the line `ark test` prints), one `step.finished` event, no crash and no stack trace. The human `take_over` run finishes the same way.
- D: exit 1 and the output names `ARK-T2` and the `ark plan check <run>` hint.

## Screenshot checkpoints

none: CLI output, exit code and the event log; no UI.
