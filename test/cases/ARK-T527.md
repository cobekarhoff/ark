---
id: ARK-T527
title: "ARK-T527 a recheck of an edited valid plan clears approval and step start names the plan gate"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: a recheck of an edited valid plan clears approval and step start names the plan gate"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a recheck of an edited valid plan clears approval and step start names the plan gate. Converted on touch from ARK-187-AC2 by the ARK-386 campaign. Production owner: `cli/events.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gate.test.ts` whose title starts with `ARK-T527`.

## Expected results

- The test passes: a recheck of an edited valid plan clears approval and step start names the plan gate.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
