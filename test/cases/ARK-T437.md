---
id: ARK-T437
title: "ARK-T437 a repos entry with a bad base is refused and names the key"
level: integration
technique: "equivalence classes (one table row for each input class)"
priority: medium
risk: "the contract breaks unnoticed: a repos entry with a bad base is refused and names the key"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a repos entry with a bad base is refused and names the key. Converted on touch from ARK-296-AC1 by the ARK-386 campaign. Production owner: `cli/config.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T437`.

## Expected results

- The test passes: a repos entry with a bad base is refused and names the key.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
