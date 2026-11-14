---
id: ARK-T466
title: "ARK-T466 a not-started finish at the last round keeps building and opens no gate"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: a not-started finish at the last round keeps building and opens no gate"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a not-started finish at the last round keeps building and opens no gate. Converted on touch from ARK-282-AC3 by the ARK-386 campaign. Production owner: `cli/events.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T466`.

## Expected results

- The test passes: a not-started finish at the last round keeps building and opens no gate.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
