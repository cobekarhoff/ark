---
id: ARK-T28
title: ARK-T28 RISK04 fails three ways and passes a good body
level: integration
technique: one fixture per failure mode (equivalence classes) plus a passing control
priority: high
risk: a body with no reviewer risk block, a one-way door with no recovery or an unplanned file with no reason passes lint, so the human reviews a risk section that does not hold
status: active
changed_by: 2026-11-06-ARK-316-1
---

## Objective

Prove that lint check RISK04 fails on each of its three conditions and passes a good body. Serves ARK-316/AC13.

Expected: When a reviewer step has no `## Merge risk` block, the system shall fail RISK04.

## Preconditions

- Fixture run with a reviewer step in `plan.yml`.
- Body 1: the latest findings file of the reviewer step has no `## Merge risk` block.
- Body 2: the body has `Door: one-way` and names no recovery.
- Body 3: a file under `Also changed, not in plan:` has no reason.
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

- Bodies 1, 2 and 3 each return `fail` for RISK04, and the reason names the cause (no `## Merge risk` block; no recovery for `Door: one-way`; the unplanned file without a reason).
- The good body returns `pass` for RISK04.
- The control run, with no reviewer step, does not fail on the missing block.
- `bun test test/pr-writing.test.ts` exits 0.

## Screenshot checkpoints

None. The surface is CLI output and Markdown text; no screenshot applies.
