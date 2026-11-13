---
id: ARK-T336
title: ARK-T336 reviewer finish passes when each unplanned file has a reason and test/ and docs/ need none
level: integration
technique: equivalence classes (unplanned with line, test/ and docs/ exempt), boundary of the path filter
priority: high
risk: the finish check over-refuses, because it demands a line for `test/` or `docs/` files or ignores a present line (path match, empty reason, wrong block), so a reviewer is blocked on a correct findings file or the repair loop never ends
status: active
changed_by: 2026-11-13-ARK-430-1
---

## Objective

Prove that finishing a reviewer step succeeds when every changed file outside the plan has a `Not in plan:` line, and that files under `test/` and `docs/` need none. Serves ARK-430/AC2.

## Preconditions

- Real git worktree and `ark` CLI, as in the `test/reviewed-head.test.ts` harness; origin present so the target-branch diff is non-empty.
- A reviewer step in `plan.yml` (started, with commits ahead) and a plan whose `summary.changes[].where` lists only `cli/run.ts`.
- The worktree changes `cli/helpers.ts` (outside the plan), `test/foo.test.ts` and `docs/foo.md`.
- `findings/<step>.md` has, in its first `## Merge risk` block, `- Not in plan: cli/helpers.ts — fixture reason`, and no line for the `test/` or `docs/` file.

## Steps

1. Run `ark run step <run> <step> finish` for the reviewer step.
2. Control: change the line to `- Not in plan: cli/helpers.ts —` (empty reason) and run finish again on a fresh run state.
3. Control: put the line in a second `## Merge risk` block only and run finish again.

## Expected results

- Step 1 exits 0 and the step is finished.
- Step 2 is refused (empty reason counts as no reason) and names `cli/helpers.ts`.
- Step 3 is refused, the same as RISK04 ignoring a second block.
- No message ever names the `test/` or `docs/` file.

## Screenshot checkpoints

none: CLI output and function results; no UI.
