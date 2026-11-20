---
id: ARK-T719
title: ARK-T719 After a model or harness change in `plan.yml`, the next start of an interrupted step starts a fresh worker and names the change; an old worker with no recorded model still restores
level: integration
technique: decision table (model same or changed, harness same or changed, model recorded or not) with a state transition across a restore
priority: high
risk: a role switch after a usage limit restores the dead model's session, so the worker runs on the model that is out of quota again; the changed-harness case restores the old harness (`workerHarness = previous.harness`); the fresh start drops the interrupted brief, so the new worker redoes or overwrites the earlier edits; a worker recorded before this change loses its restore, or a restored old worker is given the plan's model and a later switch then compares against it
status: active
changed_by: 2026-11-20-ARK-595-1
---

## Objective

Prove that `ark run step <run> <step> start` on an interrupted step starts a fresh worker with the plan's harness and model, and prints which of them changed, when `plan.yml` names another model or harness than the dead worker recorded; and that a worker recorded with no model still restores.

## Preconditions

- The fake Orca, fake session folder and scratch `ARK_HOME` of ARK-T212. `ark.yml` roles hold models `A` and `B` (plus the pairs `claude`/`A` and `claude`/`B`) for the step's role. No real Orca.
- Five interrupted steps, each with a recorded session path and an `omp` worker with model `A` unless said otherwise: (a) `plan.yml` now names model `B`; (b) `plan.yml` now names harness `claude` and the same model name `A` (roles hold the pair `claude`/`A`); (c) `plan.yml` now names harness `claude` and model `B`; (d) a hand-written old `worker.started` with no `model` key, `plan.yml` names harness `omp` and model `B`; (e) a hand-written old worker with no `model`, harness `omp`, and `plan.yml` names harness `claude`, model `A`.
- Each plan change goes through `ark plan check` and a new `ark gate record <run> plan approve`, because a new plan hash clears the approval.

## Steps

1. For (a), (b), (c), (e): run `ark run step <run> <step> start`. Read the printed `worker:` line, the fake Orca calls, the spec text the fake received and the new `worker.started`.
2. For (d): run `start`, read the printed line, the calls and the new `worker.started`; interrupt it and run `start` again with the plan unchanged.

## Expected results

- (a) the system shall print `worker: fresh (model changed: A -> B)`, shall call `worker-start --agent omp --model B`, shall run no restore command, and shall record a `worker.started` with `harness: omp`, `model: B`.
- (b) the system shall print `worker: fresh (harness changed: omp -> claude)` and call `worker-start` with the `claude` harness. It shall run no `omp --restore`.
- (c) harness and model both changed: the system shall print one line that names both changes (`harness changed: omp -> claude` and `model changed: A -> B`), shall start fresh with `claude` and `B`, and shall run no restore.
- (a), (b), (c) the fresh spec shall still say that an earlier worker was interrupted and shall name `git status` and `git diff`, and the system shall still print the `brief:` line.
- (d) an old worker with no model shall restore as today: `worker: restored`, `omp --restore <session>`, no fresh `worker-start`, although the plan names model `B`. The new `worker.started` shall hold no `model` key, and the second start with the plan unchanged shall restore again (the system shall not compare against a model that nobody checked).
- (e) an old worker with no model but another harness than the plan shall start fresh with `worker: fresh (harness changed: omp -> claude)`.
- The text shall never read `restored` for a start that ran a fresh `worker-start`.

## Screenshot checkpoints

none: integration case on CLI output, run events and the fake Orca call log; there is no UI.
