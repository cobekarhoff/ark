---
id: ARK-T27
title: ARK-T27 merge risk block shows script and reviewer levels
level: integration
technique: boundary values on the weighted mean (1.5 and 2.25, on legal score tuples either side), isolated category inputs, and a decision table on level disagreement and reviewer file order
priority: high
risk: the risk level is wrong at a threshold, a category is scored from the wrong input, an older reviewer file is read, the lower reviewer level hides a higher script level, the unplanned file lacks its reason, or the door and blast radius lines are missing
status: active
changed_by: 2026-11-06-ARK-316-1
---

## Objective

Prove that the body's risk section starts with the merge-risk line, scores four categories from run data, shows script and reviewer levels with the higher winning, and lists door, blast radius and unplanned files. Serves ARK-316/AC12.

Expected: When the script and reviewer levels differ, the system shall show the higher level and say why.

## Preconditions

- Weighted mean = (2·Verification + 2·Impact + 1.5·Rollback cost + Alignment) / 6.5. Only multiples of 1/13 are reachable, so 1.5 and 2.25 themselves are not; the legal tuples either side of each threshold are used. Tuples are (Verification, Impact, Rollback cost, Alignment).
- Main fixture run: one file in the diff that no `plan.yml` step lists under `where:` (`cli/helpers.ts`), one unlisted file under `test/` and one under `docs/`, one `sensitive_paths` hit (`cli/gate.ts`), one `one_way_paths` hit (`cli/events.ts`), a deleted file, `design.interfaces` callers, all ACs passing with evidence for each.
- Reviewer files: `findings/review-1.md` (older) with a `## Merge risk` block of level `high`; `findings/review-2.md` (latest) with a block of level `low` and a reason for `cli/helpers.ts`.
- Category inputs used by this case (the oracle for scores; each row changes one input of a baseline run with all ACs passing and evidenced, no unplanned file, no sensitive hit, no `design.interfaces` callers, no one-way hit, no deleted file, which scores 1/1/1/1):
  - Verification: all ACs passing with evidence = good (1); all passing, one AC without evidence = decent (2); one AC not passing = poor (3).
  - Alignment: 0 unplanned source files = good (1); 1 = decent (2); 3 = poor (3). Files under `test/` and `docs/` do not count.
  - Impact: no sensitive hit and no callers = good (1); one sensitive hit = decent (2); a sensitive hit with `design.interfaces` callers = poor (3).
  - Rollback cost: neither a `one_way_paths` hit nor a deleted file = good (1); one of them = decent (2); both = poor (3).
- Threshold runs, built from those inputs:
  - (1,1,3,1): one-way hit and deleted file, all else baseline. 19/13 ≈ 1.46.
  - (1,1,2,3): a deleted file only and 3 unplanned files. 20/13 ≈ 1.54.
  - (1,3,3,2): the main fixture. 29/13 ≈ 2.23.
  - (2,3,2,2): the main fixture with one AC without evidence, and the one-way hit removed (the deleted file stays). 30/13 ≈ 2.31.

## Steps

1. Build the body for the main fixture. Read the risk section.
2. Read the four category bullets and their scores.
3. Read the door line, the blast radius line, and the `Also changed, not in plan:` list.
4. Build the body for each isolated-input row of the category list (one input changed from the baseline) and read the score of the changed category and the unchanged ones.
5. Build the body for each of the four threshold runs and read the script level.
6. For the main fixture, read the reviewer level with `review-1.md` older and `review-2.md` latest. Swap the contents (older `low`, latest `high`) and read it again.
7. Build the body with a reviewer level equal to the script level, and with the reviewer level higher than the script level.
8. Run `bun test test/pr-writing.test.ts`.

## Expected results

- Main fixture scores: Verification 1 (good), Alignment 2 (decent; only `cli/helpers.ts` counts), Impact 3 (poor), Rollback cost 3 (poor); script level `medium`. The reviewer level is `low` (the latest file, not the older `high`), so the line is `Merge risk: medium (script medium, reviewer low)`, and a sentence says why the two differ. After the swap the reviewer level is `high` from the latest file and the line is `Merge risk: high (script medium, reviewer high)`. When the levels are equal there is no such sentence.
- Each isolated-input row scores only its own category as listed, and the other three stay 1.
- Threshold runs: (1,1,3,1) = 19/13 is `low`; (1,1,2,3) = 20/13 is `medium`; (1,3,3,2) = 29/13 is `medium`; (2,3,2,2) = 30/13 is `high`. So `low` is below 1.5, `medium` from 1.5 to below 2.25, `high` from 2.25.
- One bullet each for Verification, Alignment, Impact and Rollback cost, with the gaps. Scores are `good` 1, `decent` 2, `poor` 3.
- `Door: one-way` appears for the `one_way_paths` hit and names its recovery. `Door: two-way` appears for a run without a hit.
- `Blast radius: <phrase>` is present.
- `Also changed, not in plan:` lists `cli/helpers.ts` with the reason from the reviewer block, and does not list the files under `test/` or `docs/`.
- `bun test test/pr-writing.test.ts` exits 0.

## Screenshot checkpoints

None. The surface is CLI output and Markdown text; no screenshot applies.
