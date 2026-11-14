---
id: ARK-T456
title: "ARK-T456 abort after escalate closes the run"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: abort after escalate closes the run"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that abort after escalate closes the run. Converted on touch from ARK-210-AC3 by the ARK-386 campaign. Production owner: `cli/gate.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T456`.

## Expected results

- The test passes: abort after escalate closes the run.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
