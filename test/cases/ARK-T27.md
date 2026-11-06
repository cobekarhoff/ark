---
id: ARK-T27
title: ARK-T27 merge risk block shows script and reviewer levels
level: integration
technique: boundary values on the weighted mean (1.5 and 2.25) and decision table on level disagreement
priority: high
risk: the risk level is wrong at a threshold, the lower reviewer level hides a higher script level, the unplanned file lacks its reason, or the door and blast radius lines are missing
status: active
changed_by: 2026-11-06-ARK-316-1
---

## Objective

Prove that the body's risk section starts with the merge-risk line, scores four categories from run data, shows script and reviewer levels with the higher winning, and lists door, blast radius and unplanned files. Serves ARK-316/AC12.

Expected: When the script and reviewer levels differ, the system shall show the higher level and say why.

## Preconditions

- Fixture run with: one file in the diff that no `plan.yml` step lists under `where:` (`cli/helpers.ts`), one file under `test/` and one under `docs/` that are also unlisted, one `sensitive_paths` hit (`cli/gate.ts`), one `one_way_paths` hit (`cli/events.ts`), a deleted file, `design.interfaces` callers, and AC status with all ACs passing and evidence present.
- `findings/<step>.md` with a `## Merge risk` block that gives reviewer level `low` and a reason for `cli/helpers.ts`.
- Variant runs that score each category good (1), decent (2) and poor (3), to hit the weighted-mean boundaries: all good (1.0), a mix with mean exactly 1.5, a mix just under 1.5, a mix with mean exactly 2.25, and a mix just under 2.25.

## Steps

1. Build the body for the main fixture. Read the risk section.
2. Read the four category bullets (Verification, Alignment, Impact, Rollback cost) and their scores.
3. Read the door line, the blast radius line, and the `Also changed, not in plan:` list.
4. Compute the script level for each weighted-mean variant, with weights Verification 2, Impact 2, Rollback cost 1.5, Alignment 1.
5. Build the body with reviewer level equal to the script level, and with the reviewer level higher than the script level.
6. Run `bun test test/pr-writing.test.ts`.

## Expected results

- The risk section starts with `Merge risk: <level> (script <level>, reviewer <level>)`, each level one of `low`, `medium`, `high`. For the main fixture the script level is higher than the reviewer `low`, and the line shows the higher level first with both levels in the brackets.
- A sentence says why the two levels differ. When they are equal there is no such sentence.
- One bullet each for Verification, Alignment, Impact and Rollback cost, with the gaps. Verification is scored from AC status and evidence; Alignment from the unplanned files; Impact from the `sensitive_paths` hit and the `design.interfaces` callers; Rollback cost from the `one_way_paths` hit and the deleted file. Scores are `good` 1, `decent` 2, `poor` 3.
- `Door: one-way` appears for the `one_way_paths` hit, and names its recovery. `Door: two-way` appears for a run without a hit.
- `Blast radius: <phrase>` is present.
- `Also changed, not in plan:` lists `cli/helpers.ts` with the reason from the reviewer block, and does not list the files under `test/` or `docs/`.
- Script level boundaries: mean below 1.5 is `low`; 1.5 is `medium`; below 2.25 is `medium`; 2.25 and above is `high`.
- `bun test test/pr-writing.test.ts` exits 0.

## Screenshot checkpoints

None. The surface is CLI output and Markdown text; no screenshot applies.
