---
id: ARK-T102
title: ARK-T102 a spent round budget names the next command for its phase
level: integration
technique: state transition (building to escalation)
priority: medium
risk: The refusal sends the run lead to `ark gate record` while the escalation gate is not open, so it is refused and the run lead loses a round trip
status: active
changed_by: 2026-11-07-ARK-334-1
---

## Objective

Prove the refusal of a step start after the round budget is spent teaches the legal sequence in phase building (escalate, ask, record) and names `ark gate record` in phase escalation.

Expected: When the round budget is spent, the refusal shall name the command that is legal in the current phase.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.
- An isolated temp `ARK_HOME` with a run in phase building whose round counter equals the configured round budget (drive it there with the real `ark` commands or a fixture state the CLI accepts).

## Steps

1. Given the run in phase building with the budget spent, when `ark run step <run> <step> start` runs, capture exit code and stderr.
2. When `ark escalate <run> --reason "budget spent"` runs, capture exit code and the phase.
3. Given phase escalation, when `ark run step <run> <step> start` runs again, capture exit code and stderr.

## Expected results

- Step 1 exits 1 with `round budget spent` and names `ark escalate <run> --reason <text>` first, then asking, then recording the escalation gate. `ark escalate` appears before `ask` and before `ark gate record` in the message; the run, `--reason` and the three-part order are all present.
- Step 2 exits 0 and the phase is escalation.
- Step 3 exits 1 with `round budget spent` and names `ark gate record`.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
