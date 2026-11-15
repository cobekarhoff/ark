---
id: ARK-T435
title: "ARK-T435 a null or blank merge_requests is refused, not read as open"
level: integration
technique: "equivalence classes (one table row for each input class)"
priority: medium
risk: '`?? "open"` on null'
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a null or blank merge_requests is refused, not read as open. Converted on touch from ARK-295-AC1 by the ARK-386 campaign. Production owner: `cli/config.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T435`.

## Expected results

- The test passes: a null or blank merge_requests is refused, not read as open.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
