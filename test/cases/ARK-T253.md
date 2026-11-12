---
id: ARK-T253
title: ARK-T253 Home 'Starts next' lists the ready and pending Tasks of Master Chief's Run and leaves out a Task whose ticket has an open run
level: e2e
technique: equivalence classes (ready, pending, open-run Task) and a paged lookup (Run found on the last page)
priority: high
risk: "The block misses the Master Chief Run when it is not on the first run-list page, lists a Task whose ticket already has an open run, drops a pending Task, or matches a Task to the wrong ticket id"
status: active
changed_by: 2026-11-11-ARK-354-1
---

## Objective

Prove that the 'Starts next' block of a project lists exactly the tickets of the ready and pending Tasks, found by the ticket id at the start of the Task title, and no ticket that has an open run.

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts`, project `p` (`concurrency: 2` in its `ark.yml`), a fake `orca` binary first on PATH. The fake answers `orchestration run-list` in pages of 10 with a `nextCursor`, 160 Runs in all, and the Run `Master Chief: p tickets` sits on the last page.
- The queue read follows the ARK-365 idle rule: it runs on the first `/events` connection and pauses while the hub is idle.
- Queue of the fake Run: ready Tasks `ARK-801 First` and `ARK-802 Second`, pending Task `ARK-803 Third`, ready Task `ARK-804 Fourth` whose ticket has an open Ark run, and a Task titled `no id here` (no valid ticket id).
- Tickets ARK-801 to ARK-804 exist in project `p`; the open run belongs to ARK-804.

## Steps

1. Open Home. Wait until the 'Starts next' block of `p` shows.
2. Read the ticket ids in the block.
3. `checkpoint(page, "starts-next-listed")`.
4. Assert the fake recorded `run-list` calls with `--cursor` until `nextCursor` was null, and no Task-changing call.

## Expected results

- When Master Chief's Run holds ready and pending Tasks, Home shall list `ARK-801`, `ARK-802` and `ARK-803` in the 'Starts next' block of `p`.
- Home shall not list `ARK-804` (its ticket has an open run) and shall not list the Task with no ticket id; the page shall not crash on it.
- The hub shall find the Run by paging `run-list` with `--cursor` until `nextCursor` is null.
- The hub shall not change any Task.

## Screenshot checkpoints

- `starts-next-listed`: the 'Starts next' block with three tickets.
