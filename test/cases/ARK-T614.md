---
id: ARK-T614
title: "ARK-T614 workspace sync fast-forwards clean and unrelated-dirty checkouts but preserves conflicting changes"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/worktree.ts workspaceSync breaks this contract: workspace sync fast-forwards and never overwrites local changes"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that workspace sync fast-forwards clean and unrelated-dirty checkouts but preserves conflicting changes. Converted on touch from ARK-165-AC4 by the ARK-386 campaign. Production owner: `cli/worktree.ts workspaceSync`. It keeps ARK-296-AC4 too: the campaign removed the copy tests of that criterion (CAMPAIGN.md section 3, Carry).

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/sync.test.ts` whose title starts with `ARK-T614`.

## Expected results

- The test passes: workspace sync fast-forwards clean and unrelated-dirty checkouts but preserves conflicting changes.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
