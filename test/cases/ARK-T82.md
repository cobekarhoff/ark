---
id: ARK-T82
title: ARK-T82 the recorded real prompt wait gives waiting, by agentWait alone too
level: integration
technique: recorded real input replay
priority: medium
risk: The hub misreads a real prompt wait as not waiting
status: active
changed_by: 2026-11-07-ARK-322-1
---

## Objective

Prove the recorded real prompt wait gives the activity `waiting`, also when only agentWait reports it. Converted on touch from ARK-293-AC4.

Expected: When the recorded prompt wait is read, the hub shall show the agent as waiting.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test `ARK-T82 the recorded real prompt wait gives waiting, by agentWait alone too`.

## Expected results

- The test passes: the recorded real prompt wait gives the activity `waiting`, also when only agentWait reports it.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
