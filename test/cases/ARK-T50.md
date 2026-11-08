---
id: ARK-T50
title: ARK-T50 a refused native GitLab dependency still opens the MR with the Depends on line
level: integration
technique: error guessing on a failing blocks call
priority: medium
risk: a 403 on the native dependency call stops the open or drops the `Depends on` line
status: active
changed_by: 2026-11-08-ARK-336-1
---

## Objective

Prove that a refused native GitLab dependency still opens the MR with the Depends on line. This case replaces the old id ARK-155-AC3, converted when ARK-316 moved the body to a file.

## Preconditions

- The same GitLab run (the `repos` block holds the edge app to core), with the blocks call failing (403).

## Steps

1. Run `ark merge-request open <run>`.

## Expected results

- The command exits 0, the app MR description has `Depends on !1`, and both `merge_request.opened` events exist.

## Screenshot checkpoints

none: integration case on CLI output and host calls; no UI surface.
