---
id: ARK-T256
title: ARK-T256 An unreadable queue shows 'Queue unavailable: <reason>' with no ticket, for a missing Run and for a failed orca call
level: e2e
technique: error guessing over failure classes (no Run, run-list fails, task-list fails, call times out)
priority: high
risk: "A failed read shows an empty queue or stale tickets as if nothing was queued, the reason is missing or the same for every failure, a ready ticket is listed under 'Approved, not queued' because the queue is unknown, or a slow orca call delays the other Home blocks"
status: active
changed_by: 2026-11-11-ARK-354-1
---

## Objective

Prove that when the queue cannot be read the block says 'Queue unavailable: <reason>' and lists no ticket, for each failure.

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts`, project `p`, a fake `orca` binary on PATH, with ready tickets `ARK-841` and `ARK-842` in the project.
- The queue read follows the ARK-365 idle rule.
- Scenarios: (a) `run-list` returns 160 Runs over all pages, none named `Master Chief: p tickets`; (b) the Run exists but `task-list --ready` exits 1; (c) the Run exists but `task-list --status pending` sleeps past the orca time limit.

## Steps

1. For each scenario start the hub and open Home. Wait for the block of `p`.
2. Read the block text and look for any ticket row and any 'Approved, not queued' row.
3. `checkpoint(page, "queue-unavailable-<scenario>")`.
4. In (c) check that the gates, open runs and review blocks of Home show before the slow call ends.

## Expected results

- The block shall say `Queue unavailable: ` followed by a reason that names the cause: no Orca Run for Master Chief in (a), the failed call in (b), the timeout in (c).
- The block shall list no ticket in any scenario.
- Home shall not list `ARK-841` or `ARK-842` under 'Approved, not queued' in any scenario.
- A slow queue shall show a stale chip and shall not delay the other Home blocks.

## Screenshot checkpoints

- `queue-unavailable-missing-run`: block text for (a).
- `queue-unavailable-failed-call`: block text for (b).
- `queue-unavailable-timeout`: block text for (c).
