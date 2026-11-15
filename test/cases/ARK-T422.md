---
id: ARK-T422
title: "ARK-T422 strategy record stores card metadata and refuses malformed cards"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: strategy record stores card metadata and refuses malformed cards"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that strategy record stores card metadata and refuses malformed cards. Converted on touch from ARK-173-AC4 by the ARK-386 campaign. It also keeps the refusal of a Mockup link that is not a file in the run folder (strategy.ts 127-139), which ARK-T208 proved with a second test that the campaign removed. Production owner: `cli/strategy.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/strategy.test.ts` whose title starts with `ARK-T422`.

## Expected results

- The test passes: strategy record stores card metadata and refuses malformed cards.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
