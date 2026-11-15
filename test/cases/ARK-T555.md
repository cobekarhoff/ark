---
id: ARK-T555
title: "ARK-T555 an amend in awaiting_strategy is accepted and does not say the plan is approved"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: an amend in awaiting_strategy is accepted and does not say the plan is approved"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that an amend in awaiting_strategy is accepted and does not say the plan is approved. Converted on touch from ARK-308-AC1 by the ARK-386 campaign. Production owner: `cli/criteria.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/criteria-amend.test.ts` whose title starts with `ARK-T555`.

## Expected results

- The test passes: an amend in awaiting_strategy is accepted and does not say the plan is approved.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
