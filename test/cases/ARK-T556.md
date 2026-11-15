---
id: ARK-T556
title: "ARK-T556 an amend in building keeps phase and approval, clears that manual answer, and ark test reads manual pending"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: an amend in building keeps phase and approval, clears that manual answer, and ark test reads manual pending"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that an amend in building keeps phase and approval, clears that manual answer, and ark test reads manual pending. Converted on touch from ARK-308-AC3 by the ARK-386 campaign. Production owner: `cli/events.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/criteria-amend.test.ts` whose title starts with `ARK-T556`.

## Expected results

- The test passes: an amend in building keeps phase and approval, clears that manual answer, and ark test reads manual pending.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
