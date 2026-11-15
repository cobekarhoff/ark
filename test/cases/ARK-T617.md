---
id: ARK-T617
title: "ARK-T617 --merge is refused on a non-implementer start and on finish, naming the reason"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/run.ts step start and finish breaks this contract: `--merge` only on an implementer start"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that --merge is refused on a non-implementer start and on finish, naming the reason. Converted on touch from ARK-211-AC1 by the ARK-386 campaign. Production owner: `cli/run.ts step start and finish`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/sync.test.ts` whose title starts with `ARK-T617`.

## Expected results

- The test passes: --merge is refused on a non-implementer start and on finish, naming the reason.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
