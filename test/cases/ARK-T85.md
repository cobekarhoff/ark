---
id: ARK-T85
title: ARK-T85 every link in principles.md points to a file and heading that exist
level: unit
technique: link resolution
priority: medium
risk: A link in skills/ark/principles.md points to a missing file or heading
status: active
changed_by: 2026-11-07-ARK-322-1
---

## Objective

Prove every relative link in principles.md resolves to an existing file and heading. Converted on touch from ARK-303-AC5.

Expected: Every link in principles.md shall point to a file and a heading that exist.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test `ARK-T85 every link in principles.md points to a file and heading that exist`.

## Expected results

- The test passes: every relative link in principles.md resolves to an existing file and heading.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
