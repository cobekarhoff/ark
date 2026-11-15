---
id: ARK-T543
title: "ARK-T543 an old gate.answered with no by field reads as human"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: an old gate.answered with no by field reads as human"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that an old gate.answered with no by field reads as human. Converted on touch from ARK-234-AC5 by the ARK-386 campaign. Production owner: `cli/events.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gates.test.ts` whose title starts with `ARK-T543`.

## Expected results

- The test passes: an old gate.answered with no by field reads as human.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
