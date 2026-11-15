---
id: ARK-T567
title: "ARK-T567 ark test decides an AC through its verified_by cases at every level and keeps the tag path for old ACs, where a unit suite never passes an old AC"
level: integration
technique: "equivalence classes (verified_by cases at each level, old tag in a unit suite)"
priority: medium
risk: "an AC reads passing from a unit-level case alone, or a verified_by join drops a case, or an old tag in a unit suite passes an AC"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that ark test decides an AC through its verified_by cases at every level and keeps the tag path for old ACs, where a unit suite never passes an old AC. Converted on touch from ARK-311-AC2, ARK-154-AC7 by the ARK-386 campaign. It keeps the second id too: the copy test of that criterion was removed as a duplicate (CAMPAIGN.md section 3, Carry). Production owner: `cli/test-run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/test-run.test.ts` whose title starts with `ARK-T567`.

## Expected results

- The test passes: ark test decides an AC through its verified_by cases at every level and keeps the tag path for old ACs, where a unit suite never passes an old AC.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
