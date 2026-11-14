---
id: ARK-T351
title: "ARK-T351 escalation_rounds loads as 2 by default, accepts 4, and a value of -1 or many fails the load naming the field"
level: integration
technique: "equivalence classes and boundary values (absent, valid, below 0, not an integer)"
priority: high
risk: "The cap stays a constant, the default drifts from 2, or an invalid value loads silently or fails without naming escalation_rounds"
status: active
changed_by: "2026-11-13-ARK-432-1"
---

## Objective

Prove that the `ark.yml` setting `escalation_rounds` (top level, next to `round_budget`) is read, defaulted and checked by the real config loader.

## Preconditions

- A scratch ARK_HOME with a valid `ark.yml` for a scratch project.
- No real Orca, omp or test-runner.

## Steps

1. Load the config with no `escalation_rounds` line.
2. Load it with `escalation_rounds: 4`.
3. Load it with `escalation_rounds: 0`.
4. Load it with `escalation_rounds: -1`.
5. Load it with `escalation_rounds: many`.

## Expected results

- Steps 1-3: the load succeeds; the value is 2, 4 and 0.
- Steps 4-5: the load fails and the error message names `escalation_rounds`.

## Screenshot checkpoints

None. The surface is CLI output, config load errors and run events; no screenshot applies.
