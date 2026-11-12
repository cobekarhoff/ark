---
id: ARK-T255
title: ARK-T255 'Approved, not queued' lists ready tickets that have no Task and no open run
level: e2e
technique: equivalence classes over ticket x Task x run, with a boundary on Task status
priority: high
risk: "A ready ticket that Master Chief never queued is missing from the list, or a ready ticket with a Task, an open run, or a completed Task is listed"
status: active
changed_by: 2026-11-11-ARK-354-1
---

## Objective

Prove the 'Approved, not queued' list shows each status-ready ticket with no Task in the queue and no open run, with the text 'ask Master Chief to queue it'.

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts`, project `p` (`concurrency: 2` in its `ark.yml`), a fake `orca` binary first on PATH. The fake answers `orchestration run-list` in pages of 10 with a `nextCursor`, 160 Runs in all, and the Run `Master Chief: p tickets` sits on the last page.
- The queue read follows the ARK-365 idle rule: it runs on the first `/events` connection and pauses while the hub is idle.
- Tickets with status `ready`: `ARK-831` (no Task, no run), `ARK-832` (ready Task), `ARK-833` (pending Task), `ARK-834` (no Task, open run), `ARK-835` (no Task, no run).
- A ticket with status `proposed` and no Task, `ARK-836`.

## Steps

1. Open Home. Wait for the 'Starts next' block of `p`.
2. Read the 'Approved, not queued' list under the queue.
3. `checkpoint(page, "approved-not-queued")`.

## Expected results

- The list shall show `ARK-831` and `ARK-835`, each with the text `ask Master Chief to queue it`.
- The list shall not show `ARK-832`, `ARK-833` (they have a Task), `ARK-834` (open run) or `ARK-836` (status is not ready).

## Screenshot checkpoints

- `approved-not-queued`: the list with two tickets and the text on each.
