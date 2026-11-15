---
id: ARK-T525
title: "ARK-T525 plan approve after plan.yml changed since the check is refused, no event"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: plan approve after plan.yml changed since the check is refused, no event"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that plan approve after plan.yml changed since the check is refused, no event. Converted on touch from ARK-153-AC6 by the ARK-386 campaign. It keeps ARK-152-AC4 too: the copy tests of that criterion were removed as duplicates (CAMPAIGN.md section 3, Carry). Production owner: `cli/transitions.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gate.test.ts` whose title starts with `ARK-T525`.

## Expected results

- The test passes: plan approve after plan.yml changed since the check is refused, no event.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
