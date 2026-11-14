---
id: ARK-T378
title: "ARK-T378 ark retro keeps a session that nothing places as unassigned, apart from the run lead, and names its file in the output"
level: integration
technique: "equivalence classes on session owner (run lead, no owner); invariant (orchestration is the run lead only)"
priority: high
risk: "a session with no spec line, in no window and named by no worker.started event is added to orchestration again, so the run lead cost is too high and the unassigned cost vanishes from by_role; the unassigned key is missing from by_role or by_step; the output line unassigned: 1 file or its file name is lost"
status: active
changed_by: 2026-11-13-ARK-460-1
---

## Objective

Prove that `ark retro` shows a session that nothing places as `unassigned` in `cost.by_role`, in `cost.by_step` and in the output, and that `orchestration` holds the run lead only. Serves ARK-460/AC3.

Expected: When a session has no spec line of this run, is in no step window and no `worker.started` event names it, the system shall put its cost under `unassigned` in `cost.by_role` and `cost.by_step`, keep `orchestration` for the run lead session only, and print `unassigned: 1 file` with its file name.

## Preconditions

- A temporary `ARK_HOME` with a closed run: one implementer step with `step.started` and `step.finished`.
- Two OMP session files with the run's worktree as `cwd` and different known costs:
  - Run lead: starts before the first step and is written at or after it.
  - File U: starts before `step.started` (in the gap before the window) or after `step.finished`, so no window holds it. Its first prompt has no worker spec line of this run. No `worker.started` event names it.
- Variant: a second file U2 that starts later than the run lead and has the same properties, so the run lead stays the earliest-starting candidate.

## Steps

1. Run `ark retro <run>` and read its exit code and output.
2. Read `cost.by_role`, `cost.by_step`, `cost.total_usd` and `master_chief_and_run_lead_cost` in `metrics.json`.

## Expected results

- Exit 0.
- `cost.by_role.orchestration` is the cost of the run lead file only, and equals `master_chief_and_run_lead_cost`.
- `cost.by_role.unassigned` and `cost.by_step.unassigned` are the cost of file U.
- The output has the line `unassigned: 1 file` with the cost and the name of file U.
- The sum of the `cost.by_role` costs equals `cost.total_usd`.
- With U2 the line says `unassigned: 2 files` and names both; `orchestration` does not change.

## Screenshot checkpoints

None. The surface is CLI output and JSON; no screenshot applies.
