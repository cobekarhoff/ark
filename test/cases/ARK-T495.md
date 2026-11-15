---
id: ARK-T495
title: "ARK-T495 plan.md renders Given/When/Then groups in order, omits an empty given, and puts Expected after the block"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: plan.md renders Given/When/Then groups in order, omits an empty given, and puts Expected after the block"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that plan.md renders Given/When/Then groups in order, omits an empty given, and puts Expected after the block. Converted on touch from ARK-172-AC2 by the ARK-386 campaign. It keeps ARK-172-AC1, ARK-172-AC3 too: the copy tests of those criteria were removed as duplicates (CAMPAIGN.md section 3, Carry). Production owner: `cli/plan-check.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/plan.test.ts` whose title starts with `ARK-T495`.

## Expected results

- The test passes: plan.md renders Given/When/Then groups in order, omits an empty given, and puts Expected after the block.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
