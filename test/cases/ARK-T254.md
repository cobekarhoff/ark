---
id: ARK-T254
title: ARK-T254 Each ticket in 'Starts next' shows one reason, and ready Tasks come before pending Tasks in roadmap rank, then ticket id
level: e2e
technique: state transition (open runs below, at, and above the limit) and decision table over Task state x run count
priority: high
risk: "A ready Task shows 'starts next' when the open runs are already at `concurrency`, a pending Task shows no or a wrong dependency list, the open/limit numbers differ from `ark chief state`, or the order ignores the roadmap rank for ready or pending Tasks, or keeps the supplied order for ties"
status: active
changed_by: 2026-11-11-ARK-354-1
---

## Objective

Prove the three reasons and the order: 'starts next', 'starts when a run closes (<open>/<limit> open)' and 'waits on <ticket ids>'.

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts`, project `p` (`concurrency: 2` in its `ark.yml`), a fake `orca` binary first on PATH. The fake answers `orchestration run-list` in pages of 10 with a `nextCursor`, 160 Runs in all, and the Run `Master Chief: p tickets` sits on the last page.
- The queue read follows the ARK-365 idle rule: it runs on the first `/events` connection and pauses while the hub is idle.
- Queue, Tasks listed in this supplied order (the fake returns them so): ready `ARK-812`, `ARK-811`, `ARK-813`, `ARK-809`; pending `ARK-815`, `ARK-814`, `ARK-816`. `ARK-815` depends on `ARK-820` and `ARK-821` (both unfinished; `ARK-822` is finished and not named); `ARK-814` depends on `ARK-820`; `ARK-816` depends on `ARK-820`.
- Roadmap rank: ready side `ARK-813` first, then `ARK-812`; `ARK-811` and `ARK-809` are not on the roadmap (unranked tie, supplied in reverse id order). Pending side `ARK-816` rank 1, `ARK-815` rank 2 (rank conflicts with id order); `ARK-814` is not on the roadmap.
- Two scenarios: A has 1 open run (below `concurrency: 2`); B has 2 open runs (at the limit).

## Steps

1. Scenario A: open Home. Read each row of the block with its reason.
2. `checkpoint(page, "starts-next-reasons-below-limit")`.
3. Scenario B: add a second open run, reload Home, read the rows.
4. `checkpoint(page, "starts-next-reasons-at-limit")`.

## Expected results

- Scenario A: each ready Task shall show `starts next`.
- Scenario B: each ready Task shall show `starts when a run closes (2/2 open)`; the numbers equal the open-run count and `concurrency` that `ark chief state` reports.
- Each pending Task shall show `waits on` with only its unfinished dependencies (`ARK-815`: `ARK-820, ARK-821`; `ARK-814`: `ARK-820`; `ARK-816`: `ARK-820`), in both scenarios.
- The rows shall be in exactly this order: `ARK-813`, `ARK-812`, `ARK-809`, `ARK-811` (ready: rank, then unranked by ticket id, so `ARK-809` before `ARK-811` although supplied after it), then `ARK-816`, `ARK-815`, `ARK-814` (pending: rank 1, rank 2, then unranked; this breaks ticket-id order, so an implementation ignoring pending rank fails).
- Pending `ARK-816` shall show `waits on ARK-820`.
- The block shall not say the order is Master Chief's order.

## Screenshot checkpoints

- `starts-next-reasons-below-limit`: rows with `starts next` and the three `waits on` rows.
- `starts-next-reasons-at-limit`: rows with `starts when a run closes (2/2 open)`.
