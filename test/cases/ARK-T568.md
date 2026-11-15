---
id: ARK-T568
title: "ARK-T568 the cleanup of one copy of the lock tests leaves the runner of another copy with the same run id alone"
level: integration
technique: "state transition (cleanup with a foreign runner of the same run id)"
priority: medium
risk: "the cleanup of one copy of the file kills the runner another copy or another agent started under its own ARK_HOME (the ARK-419 flake class)"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that the cleanup of one copy of the lock tests leaves the runner of another copy with the same run id alone. The test had no case id; the ARK-386 campaign gives it one. Production owner: `test/test-lock.test.ts (killStarted, runnerPids)`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/test-lock.test.ts` whose title starts with `ARK-T568`.

## Expected results

- The test passes: the cleanup of one copy of the lock tests leaves the runner of another copy with the same run id alone.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
