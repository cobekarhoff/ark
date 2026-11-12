---
id: ARK-T257
title: ARK-T257 A ticket shows as queued only when the Orca queue has its Task; a ready ticket with no Task shows as approved, not queued on the Roadmap and the ticket page
level: e2e
technique: decision table over status x Task x dependencies x queue readability
priority: high
risk: "A ready ticket that Master Chief never queued still shows `queued`, a ticket with an unfinished dependency loses `blocked`, or an unreadable queue marks every ready ticket 'approved, not queued'"
status: active
changed_by: 2026-11-11-ARK-354-1
---

## Objective

Prove the queued label comes from the Orca queue: queued with a Task, 'approved, not queued' without one, `blocked` ahead of both, and no 'approved, not queued' label when the queue is unreadable.

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts`, project `p` (`concurrency: 2` in its `ark.yml`), a fake `orca` binary first on PATH. The fake answers `orchestration run-list` in pages of 10 with a `nextCursor`, 160 Runs in all, and the Run `Master Chief: p tickets` sits on the last page.
- The queue read follows the ARK-365 idle rule: it runs on the first `/events` connection and pauses while the hub is idle.
- Ready tickets: `ARK-851` (ready Task), `ARK-852` (no Task), `ARK-853` (pending Task, an unfinished dependency).
- Scenario B: the same hub with the Master Chief Run missing.

## Steps

1. Scenario A: open the Roadmap. Read the label of each of the three tickets.
2. `checkpoint(page, "roadmap-queued-labels")`.
3. Open `#/ticket/ARK-851`, `#/ticket/ARK-852` and `#/ticket/ARK-853`. Read the state label on each page.
4. `checkpoint(page, "ticket-page-approved-not-queued")` on `ARK-852`.
5. Scenario B: open the Roadmap and the ticket page of `ARK-852`. Read the labels.

## Expected results

- `ARK-851` shall show `queued` on the Roadmap and on its ticket page.
- `ARK-852` shall show `approved, not queued` on the Roadmap and on its ticket page.
- `ARK-853` shall show `blocked`, not `queued`.
- In scenario B no ticket shall show `approved, not queued`.

## Screenshot checkpoints

- `roadmap-queued-labels`: Roadmap rows with the three labels.
- `ticket-page-approved-not-queued`: the ticket page of `ARK-852`.
