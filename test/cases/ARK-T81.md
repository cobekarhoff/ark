---
id: ARK-T81
title: ARK-T81 Map.tsx is gone
level: unit
technique: file absence
priority: medium
risk: The retired Map page returns to the hub source
status: retired
retired_reason: asserted a file layout (Map.tsx absent), not behavior
changed_by: 2026-11-07-ARK-322-1
---

## Objective

Prove hub/page/Map.tsx does not exist. Converted on touch from ARK-285-AC1.

Expected: The hub shall have no Map page file.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test `ARK-T81 Map.tsx is gone`.

## Expected results

- The test passes: hub/page/Map.tsx does not exist.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
