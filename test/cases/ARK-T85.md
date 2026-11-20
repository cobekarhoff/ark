---
id: ARK-T85
title: ARK-T85 every link in principles.md and engineering.md points to a file and heading that exist
level: unit
technique: link resolution
priority: medium
risk: A link in skills/shared/principles.md or skills/shared/engineering.md (new in ARK-579, which links to rules.md and the test authoring gate) points to a missing file or heading, so a worker that follows it reads nothing
status: active
changed_by: 2026-11-20-ARK-579-1
---

## Objective

Prove every relative link in principles.md and engineering.md resolves to an existing file and heading. Converted on touch from ARK-303-AC5. ARK-579 adds engineering.md to the scan.

Expected: Every link in principles.md and engineering.md shall point to a file and a heading that exist.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.
- `skills/shared/principles.md` and `skills/shared/engineering.md` exist and each holds at least one relative link. The test fails when a file is missing or holds none, so an empty scan cannot pass.

## Steps

1. Run the test `ARK-T85 every link in principles.md and engineering.md points to a file and heading that exist`.

## Expected results

- The test passes: every relative link in principles.md and engineering.md resolves to an existing file and heading.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
