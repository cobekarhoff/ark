---
id: ARK-T520
title: "ARK-T520 criteria edit keeps waiting, criteria abort closes the run as aborted"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: criteria edit keeps waiting, criteria abort closes the run as aborted"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that criteria edit keeps waiting, criteria abort closes the run as aborted. Converted on touch from ARK-153-AC5 by the ARK-386 campaign. It keeps ARK-170-AC2 too: the copy tests of that criterion were removed as duplicates (CAMPAIGN.md section 3, Carry). The `edit` half (criteria edit does not end the awaiting_criteria wait) is proved here, and it is the test that goes red when `cli/events.ts` lets edit end the wait; ARK-T535 proves the accept half. Production owner: `cli/gate.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gate.test.ts` whose title starts with `ARK-T520`.

## Expected results

- The test passes: criteria edit keeps waiting, criteria abort closes the run as aborted.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
