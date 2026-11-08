---
id: ARK-T107
title: ARK-T107 merge-request open uses the repos order, and merge_request.opened holds order and waits_for
level: integration
technique: state transition (plan to opened events), boundary on old plans
priority: high
risk: MRs open in an order that comes from step `needs`, or the event lacks `order` and `waits_for`, so a later merge or resume cannot tell which MR waits for which
status: active
changed_by: 2026-11-08-ARK-336-1
---

## Objective

Prove that `ark merge-request open` opens MRs in the `repos` order, writes `order` and `waits_for` (the MR numbers of the upstream repos) in each `merge_request.opened` event, and still reads old events and old plans.

## Preconditions

- A fixture run in the review-passed phase with the 3-repo plan of the mockup and a stub MR host command that returns numbers 412, 88 and 31 (the host is the only fake). The step `needs` of the plan order the repos opposite to the `repos` graph.
- A second run folder whose plan has several repos and no `repos` list, and an `events.ndjson` with a `merge_request.opened` event that has no `order` and no `waits_for`.

## Steps

1. Run `ark merge-request open <run>`.
2. Read the `merge_request.opened` events and the printed lines.
3. Interrupt after the first MR, run the command again (resume the ledger) and read the events.
4. Run `ark merge-request open` on the old plan, and read the state of the run with the old event.

## Expected results

- The MRs shall open in the order core, platform, reports, and the events shall hold `order` 1, 2, 3.
- `waits_for` shall hold `[]`, `[412]` and `[412, 88]`, and each printed line shall end with `waits for !412, !88` where it applies.
- When the command resumes, the order and `waits_for` shall be the same as without the interrupt, and no MR shall open twice.
- When the plan has no `repos` list, the order shall come from step `needs`, and the old event without `order` shall load without an error.

## Screenshot checkpoints

none: integration case on command output and events.
