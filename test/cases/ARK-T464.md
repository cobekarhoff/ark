---
id: ARK-T464
title: "ARK-T464 --not-started needs a running start"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: --not-started needs a running start"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that --not-started needs a running start. Converted on touch from ARK-282-AC2 by the ARK-386 campaign. Production owner: `cli/run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T464`.

## Expected results

- The test passes: --not-started needs a running start.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
