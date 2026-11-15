---
id: ARK-T620
title: "ARK-T620 --merge is refused after a succeeded merge step until a new sync conflicts"
level: integration
technique: "scenario through the real CLI against temporary git repos and run folders"
priority: medium
risk: "a regression in cli/run.ts merge guard breaks this contract: a succeeded merge step uses up the conflict"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that --merge is refused after a succeeded merge step until a new sync conflicts. Converted on touch from ARK-233-AC1 by the ARK-386 campaign. Production owner: `cli/run.ts merge guard`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/sync.test.ts` whose title starts with `ARK-T620`.

## Expected results

- The test passes: --merge is refused after a succeeded merge step until a new sync conflicts.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
