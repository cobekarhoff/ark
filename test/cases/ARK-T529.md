---
id: ARK-T529
title: "ARK-T529 a manual answer for an unknown or non-manual criterion is refused and names it"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: a manual answer for an unknown or non-manual criterion is refused and names it"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a manual answer for an unknown or non-manual criterion is refused and names it. Converted on touch from ARK-283-AC2 by the ARK-386 campaign. Production owner: `cli/transitions.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gate.test.ts` whose title starts with `ARK-T529`.

## Expected results

- The test passes: a manual answer for an unknown or non-manual criterion is refused and names it.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
