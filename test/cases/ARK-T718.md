---
id: ARK-T718
title: ARK-T718 `worker.started` records the step's `model` next to `harness`, and an interrupted step whose plan harness and model are unchanged still restores
level: integration
technique: equivalence classes (recorded model, none) with a state transition (running to interrupted to restored)
priority: high
risk: the event omits `model`, so no later start can see a model switch; a restored start writes the plan's model into a worker that no one checked, so a later switch compares against a model the worker never ran; the new compare stops restoring a step whose harness and model did not change
status: active
changed_by: 2026-11-20-ARK-595-1
---

## Objective

Prove that every `worker.started` event records the `model` of the plan step beside its `harness`, and that the next start of an interrupted step still restores the session when `plan.yml` names the harness and model the dead worker recorded.

## Preconditions

- The fake Orca, fake session folder and scratch `ARK_HOME` of ARK-T212. No real Orca, no real `omp`.
- `ark.yml` roles hold models `A` and `B` for the role of the step; `plan.yml` names harness `omp` and model `A` for the interrupted step. The plan gate is approved.
- Step 1 is interrupted: a fresh start recorded a `worker.started` with a session file path, then the step was interrupted.
- Step 2 is interrupted by an old worker: a hand-written `worker.started` with a session path, harness `omp` and no `model` key. The plan names model `A` for it.

## Steps

1. Run `ark run step <run> <step1> start` for a first start and read the `worker.started` event.
2. Interrupt the step. Run `ark run step <run> <step1> start` again. Read the printed `worker:` line, the fake Orca calls and the new `worker.started`.
3. Run `start` on step 2 and read the printed line, the calls and the new `worker.started`.

## Expected results

- The first `worker.started` shall hold `harness: omp` and `model: A`, as the plan step names them, besides `step`, `dispatch`, `terminal` and `session`.
- Step 1 restart: the system shall print a `worker:` line that starts `worker: restored`, shall run `omp --restore <session>` with the recorded path, shall make no fresh `worker-start --agent` call, and shall record a new `worker.started` with `model: A`.
- Step 2 restart (old worker, no model, unchanged harness): the system shall start with `worker: restored` and run `omp --restore <session>`. The new `worker.started` shall hold no `model` key: it shall not claim the plan's `A`.

## Screenshot checkpoints

none: integration case on CLI output, run events and the fake Orca call log; there is no UI.
