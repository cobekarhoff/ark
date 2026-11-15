---
id: ARK-T482
title: "ARK-T482 the first two handed_off refusals keep their text and come first"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: the first two handed_off refusals keep their text and come first"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that the first two handed_off refusals keep their text and come first. Converted on touch from ARK-304-AC5 by the ARK-386 campaign. Production owner: `cli/transitions.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T482`.

## Expected results

- The test passes: the first two handed_off refusals keep their text and come first.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
