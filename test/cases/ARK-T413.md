---
id: ARK-T413
title: ARK-T413 no tracked repo file points to the deleted personal skill folder of the old brainstorm skill
level: unit
technique: search of tracked files for one path
priority: low
risk: "a tracked file points to the personal skill folder under `~/.agents/skills/` that ARK-182 deleted at cutover; the old check searched the bare skill name, which is also the name of the repo's own `ark-brainstorm` skill since ARK-414, so it failed on every file that names the new skill"
status: active
changed_by: 2026-11-14-ARK-414-1
---

## Objective

Prove that no tracked file names the path of the personal brainstorm skill folder (`.agents/skills/` followed by the skill name) that ARK-182 deleted. Converted on touch from ARK-182-AC3: the repo now has its own skill `skills/ark-brainstorm/` (ARK-414), so a search for the bare name finds the new skill, not a pointer to the old one.

Expected: When the tracked files are searched, none shall name the path of the deleted personal skill folder.

## Preconditions

- The worktree on the latest commit of the branch.

## Steps

1. Run the test `ARK-T413 no tracked repo file points to the deleted personal skill folder of the old brainstorm skill`.

## Expected results

- `git grep` for the personal skill path finds no tracked file and exits 1.

## Screenshot checkpoints

None. The surface is files; no screenshot applies.
