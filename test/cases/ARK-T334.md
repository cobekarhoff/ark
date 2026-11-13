---
id: ARK-T334
title: "ARK-T334 finish --failed and finish --failed --not-started are not refused when the worktree is dirty"
level: integration
technique: "equivalence classes of finish outcome (success, failed, not-started) against a dirty worktree"
priority: high
risk: "the dirty guard also blocks a failed or dead worker's finish, so the run lead cannot record the failure and the step is stuck"
status: active
changed_by: 2026-11-13-ARK-429-1
---

## Objective

Prove that `finish --failed` and `finish --failed --not-started` succeed on a step whose worktree holds an untracked file, so a failed worker may leave work behind.

## Preconditions

- Two running steps (or one reset between runs), each with a real git worktree holding an untracked file.

## Steps

1. Run `ark run step <run> <step> finish --failed`.
2. On the second step, run `ark run step <run> <step> finish --failed --not-started`.
3. Read `events.ndjson`.

## Expected results

- Each command shall exit 0.
- Each shall append its `step.finished` (failed) event, with not-started recorded for the second.
- The untracked file shall remain in the worktree.

## Screenshot checkpoints

none: integration case on CLI exit code and events; no UI surface.
