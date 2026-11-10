---
id: ARK-T193
title: ARK-T193 temp-cleaner treats an empty, non-numeric or unreadable owner file as no owner file and a pid of another user as alive
level: integration
technique: equivalence classes of owner-file content (valid live, valid dead, empty, text, zero, negative, unreadable, other-user pid)
priority: medium
risk: a half-written or garbage ark-owner.pid reads as a dead owner and the root is removed at 12 minutes under a live process; or a live pid of another user (kill -0 EPERM) reads as dead
status: active
changed_by: 2026-11-10-ARK-404-1
---

## Objective

The cleaner decides liveness only from a valid pid. Invalid content is "no owner file" (180 minutes). A live process that `kill -0` cannot signal (EPERM) counts as alive.

## Preconditions

- Scratch `TMPDIR`, temp git repo as workspace; folders of kind `ark-*` aged to 60 minutes after their file is written.
- Files: empty; `abc`; `0`; `-5`; pid 1 (launchd, alive, another user, EPERM); a file holding a live child's pid with mode 000 (unreadable).
- The unreadable fixture is valid only if the test first proves reading it fails (`open` throws EACCES). If the suite runs as root, so the read succeeds, that fixture is skipped with a reported reason, not passed.

## Steps

1. Run the cleaner with all of the above aged to 60 minutes.
2. Age the empty/text/zero/negative/unreadable folders to 200 minutes; run again.

## Expected results

- Step 1: empty, text, zero, negative-pid and unreadable-file folders survive (60 < 180); the pid 1 folder survives (alive).
- Step 2: the five invalid folders are removed (unreadable counts as no owner file, even though its pid is live); the pid 1 folder still exists.

## Screenshot checkpoints

none: no UI.
