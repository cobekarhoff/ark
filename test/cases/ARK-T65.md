---
id: ARK-T65
title: ARK-T65 retro gives each session file whole to one owner, so an overlapping run lead does not show as the reviewer's model
level: integration
technique: state transition on file ownership (run lead, one step, unassigned) with an overlapping time window; equivalence classes on file start
priority: high
risk: a run lead session in the same worktree that overlaps a reviewer step window still lands in the reviewer's actual_models, vendors or cost; an unassigned file vanishes from the output; the ARK-310 fixtures that put several steps in one file pass for the wrong reason
status: active
changed_by: 2026-11-07-ARK-348-1
---

## Objective

Prove that `ark retro` maps each session file of a run whole to the run lead, one step, or unassigned, with the shared owner rule, and takes `actual_models`, step vendors and step cost only from the files a step owns. Serves ARK-348/AC1.

Expected: When a run lead session overlaps a reviewer step window in the same worktree, the system shall list only the models of the reviewer's own session in the reviewer's `actual_models`.

## Preconditions

- A temporary `ARK_HOME` with a closed run: events for an implementer step (omp, Anthropic) and a reviewer step (omp, OpenAI), each with `step.started` and `step.finished`.
- Session fixtures, one file per owner, all with the run's worktree as `cwd`:
  - File L: run lead, starts before the first step, Anthropic replies with times that fall inside both step windows.
  - File I: implementer, starts inside its window, Anthropic replies.
  - File R: reviewer, starts inside its window, OpenAI replies only.
  - File U: starts before `step.started` of the reviewer (the ARK-284 gap), OpenAI replies with a known cost.
- The ARK-310 fixtures in `test/retro.test.ts` rewritten one file per step (no file holds the messages of two steps), and their titles carry test case ids.

## Steps

1. Run `ark retro` on the run.
2. Read `actual_models`, the vendors and the cost of the reviewer and the implementer step in `metrics.json` and in the output.
3. Read the cost line of unassigned files, and `cost.by_step` and `by_role` keys.
4. Run `bun test test/retro.test.ts`.

## Expected results

- The reviewer's `actual_models` is the OpenAI model only; no Anthropic model of file L appears.
- The implementer's `actual_models` is the Anthropic model of file I only.
- The reviewer's cost is the cost of file R; cost of file L is not in any step cost.
- File U counts for no step; its cost is shown as its own unassigned line in the output and in `metrics.json`.
- `by_role` keys (evaluator, designer, orchestration) and `cost.by_step` keys are the same as before the change.
- The same fixtures, given to the shared owner function, give the same owners the hub gets (see ARK-T75).
- `bun test test/retro.test.ts` exits 0.

## Screenshot checkpoints

None. The surface is CLI output and JSON; no screenshot applies.
