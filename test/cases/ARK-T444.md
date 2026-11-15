---
id: ARK-T444
title: "ARK-T444 status exits 1 and names the bad field and project"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: status exits 1 and names the bad field and project"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that status exits 1 and names the bad field and project. Converted on touch from ARK-152-AC2 by the ARK-386 campaign. Production owner: `cli/run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T444`.

## Expected results

- The test passes: status exits 1 and names the bad field and project.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
