---
id: ARK-T337
title: ARK-T337 RISK04 uses a reason from an earlier reviewer findings file when a later file omits it
level: integration
technique: state transition across findings rounds, equivalence classes (earlier reason, later empty reason, later non-empty reason)
priority: high
risk: the ledger reads only the last findings file of a reviewer step, so a later review that does not repeat the reasons erases them and `ark merge-request open` is refused with RISK04 (seen in 7 runs, ARK-323-1 up to round 6)
status: active
changed_by: 2026-11-13-ARK-430-1
---

## Objective

Prove that the ledger merges the `Not in plan:` reasons of every reviewer findings file of one reviewer step and that RISK04 passes when only an earlier file has the line. Serves ARK-430/AC3.

## Preconditions

- Fixture run with one reviewer step in `plan.yml`, so `findings/<step>.md` (unnumbered, sorts first) and `findings/<step>-2.md` exist.
- A changed file `cli/helpers.ts` outside every plan `where`.
- File 1 has a `## Merge risk` block with `- Not in plan: cli/helpers.ts — first reason`. File 2 has a block (ratings, door) and no `Not in plan:` line.
- A PR body that lists `cli/helpers.ts` under `Also changed, not in plan:` with the reason, as `body.ts` writes it.

## Steps

1. Build the ledger and run the pr-writing lint on the body.
2. Control: remove the line from file 1 as well and lint again.
3. Control: file 2 has `- Not in plan: cli/helpers.ts —` (empty reason) and file 1 has the reason; lint again.
4. Control: file 2 gives a different non-empty reason; read the ledger entry.
5. Control: add a `round-N.md` file and a non-reviewer group file carrying the line only; lint with files 1 and 2 lacking it.

## Expected results

- Step 1: RISK04 passes; the ledger holds the reason from file 1.
- Step 2: RISK04 fails with `no reason given` for `cli/helpers.ts`.
- Step 3: RISK04 passes; the empty later reason does not erase the earlier one.
- Step 4: the later non-empty reason wins.
- Step 5: RISK04 still fails; `round-N.md` and non-reviewer files stay excluded.
- Ratings, door and recovery still come from the latest file.

## Screenshot checkpoints

none: CLI output and function results; no UI.
