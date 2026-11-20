---
id: ARK-T696
title: "ARK-T696 ark status names an unopened MR: open project says `not opened yet`, none project says `(local only)`, a run with MRs lists them"
level: integration
technique: "equivalence classes of the merge requests line: open project with no MR, none project, open project with MRs"
priority: high
risk: "an open project's run with no MR prints a bare `merge requests: none`, which a run lead reads as `merge_requests: none` in ark.yml and skips `ark merge-request open` (ARK-427, ARK-431); or the fix breaks the local-only line or the MR list"
status: active
changed_by: 2026-11-19-ARK-464-1
---

## Objective

Prove that `ark status <run>` tells the three merge request states apart by their words: an open project whose run has no MR prints `merge requests: not opened yet`, a `merge_requests: none` project prints `merge requests: none (local only)`, and a run with MRs prints the `merge requests:` header and one `  <repo> <url>` line for each MR. The bare line `merge requests: none` never prints.

Authoring gate:

1. Protects the observable `ark status` output line that tells a run lead whether the project is local-only or the MR is still to open.
2. Fails if the open-project no-MR line goes back to `none`, if the local-only line loses `(local only)`, or if the MR list stops printing.
3. ARK-T470 and ARK-T471 pin the no-MR line on the open and the invalid-field paths, and ARK-T116 pins the local-only line with its branch lines. None puts the three states side by side, and none covers a run with MRs, so no existing proof catches a change that makes two states print the same. This case owns the distinction between the three states; ARK-T470, ARK-T471 and ARK-T116 keep their own paths.
4. No hook: real `ark` process on fixture project files and run events.

## Preconditions

- A fixture open project (`merge_requests: open`) with a run that has a worktree and no `merge_request.opened` event.
- A fixture `merge_requests: none` project with a run that has a worktree.
- A run of an open project with two `merge_request.opened` events (`repo`, `url`, `number`) in its events. Real `ark`, no mocks.

## Steps

1. Run `ark status <run>` for the open-project run with no MR.
2. Run `ark status <run>` for the `none` project run.
3. Run `ark status <run>` for the open-project run with the two MR events.

## Expected results

- Step 1: exit code 0, the output holds the line `merge requests: not opened yet`, no line `merge requests: none`, and no `(local only)`.
- Step 2: exit code 0, the output holds `merge requests: none (local only)`, no line `merge requests: not opened yet`, and no bare `merge requests: none` line.
- Step 3: exit code 0, the output holds a `merge requests:` header followed by one `  <repo> <url>` line for each MR in event order. The merge-request header and list hold neither `not opened yet` nor `none`. The assertion is scoped to the merge-request header line and the MR lines under it, not to the whole output: `ark status` prints `none` elsewhere (`current step: none`, `waiting gate: none`, `last test: none`, `cli/run.ts:918-924`), and the fixture runs no test.

## Screenshot checkpoints

none: integration case on command output.
