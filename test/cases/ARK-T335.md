---
id: ARK-T335
title: ARK-T335 reviewer finish is refused for an unplanned file with no reason and names the line
level: integration
technique: equivalence classes (unplanned file without reason), error guessing on message content
priority: high
risk: a reviewer finishes with an unplanned file and no reason, so RISK04 refuses the merge request later at `ark merge-request open`, or the refusal names no file, line or findings path so the reviewer cannot repair it
status: active
changed_by: 2026-11-13-ARK-430-1
---

## Objective

Prove that finishing a reviewer step is refused when a changed file is outside every plan `where` and the findings file has no `Not in plan:` line for it. Serves ARK-430/AC1.

## Preconditions

- Real git worktree and `ark` CLI, as in the `test/reviewed-head.test.ts` harness; origin present so the target-branch diff is non-empty.
- A reviewer step in `plan.yml` (started, with commits ahead) and a plan whose `summary.changes[].where` lists only `cli/run.ts`.
- The run's worktree changes `cli/helpers.ts` (not in any `where`).
- `findings/<step>.md` exists with a `## Merge risk` block and no `Not in plan:` line (variant: the file does not exist).

## Steps

1. Run `ark run step <run> <step> finish` for the reviewer step; read exit code and output.
2. Repeat with `findings/<step>.md` absent.
3. Repeat with `--failed` and with `--not-started` on the same run (control).

## Expected results

- Exit code is 1.
- The message names `cli/helpers.ts`, the line to write in the form `Not in plan: cli/helpers.ts — <reason>` (with the `—` separator `parseReviewerBlock` accepts), and the path `findings/<step>.md`, also when the file is absent.
- The step is not marked finished.
- `--failed` and `--not-started` finishes are not refused.

## Screenshot checkpoints

none: CLI output and function results; no UI.
