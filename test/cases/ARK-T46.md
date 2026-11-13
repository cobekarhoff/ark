---
id: ARK-T46
title: ARK-T46 RISK04 fails three ways and passes a good body
level: integration
technique: one fixture per failure mode (equivalence classes) plus a passing control
priority: high
risk: a body with no reviewer risk block, a one-way door with no recovery or an unplanned file with no reason passes lint, so the human reviews a risk section that does not hold
status: active
changed_by: 2026-11-13-ARK-430-1
---

## Objective

Prove that lint check RISK04 fails on each of its three conditions and passes a good body. Serves ARK-316/AC13.

Expected: When a reviewer step has no `## Merge risk` block, the system shall fail RISK04.

## Preconditions

- Fixture run with a reviewer step in `plan.yml`.
- Body 1: the latest findings file of the reviewer step has no `## Merge risk` block. In the body, `Door: one-way` names its recovery and every unplanned file has a reason.
- Body 2: the findings file has the block and every unplanned file has a reason; the body has `Door: one-way` and names no recovery.
- Body 3: the findings file has the block and `Door: one-way` names its recovery; a file under `Also changed, not in plan:` has no reason (another file there has one).
- Good body: a findings file with the block, `Door: one-way` with its recovery, and every unplanned file with a reason.
- Control run: no reviewer step in the plan, so the block is not required.

## Steps

1. Run lint on body 1. Read the RISK04 result and reason.
2. Run lint on body 2.
3. Run lint on body 3.
4. Run lint on the good body.
5. Run lint on the control run's body.
6. Run `bun test test/pr-writing.test.ts`.

## Expected results

- Bodies 1, 2 and 3 each return `fail` for RISK04, each only for its one broken condition, and the reason names the cause (no `## Merge risk` block; no recovery for `Door: one-way`; for body 3 the new message naming the unplanned file, the line `Not in plan:` and the findings path `findings/<step>.md`).
- The good body returns `pass` for RISK04.
- The control run, with no reviewer step, does not fail on the missing block.
- `bun test test/pr-writing.test.ts` exits 0.

## Screenshot checkpoints

None. The surface is CLI output and Markdown text; no screenshot applies.
