---
id: ARK-T224
title: "ARK-T224 after the MRs open, merge starts are answered by auto and not counted, repair starts are counted up to the budget"
level: integration
technique: "state transition (round budget) plus equivalence classes of start kind (merge vs repair)"
priority: medium
risk: "a --merge start spends a round, or records a non-merge auto answer, or the budget stops refusing the third repair start"
status: active
changed_by: 2026-11-10-ARK-359-1
---

## Objective

Prove that with `gates.escalation: auto`, after the MRs open, three `--merge` starts after a conflicting sync are answered by auto with `merge: true` and are not counted, two repair starts are counted (1 of 2, 2 of 2), and the next start is refused as round budget spent.

## Preconditions

- A building run with `gates.escalation: auto`, a worktree, a fake `orca` that answers `worker-start`, and `origin/HEAD` set in the worktree.
- A finished first round and a `merge_request.opened` event.

## Steps

1. Append a conflicting `worktree.synced` event, run `ark run step <run> build start --merge`, then finish the step. Repeat three times.
2. Run `start` without `--merge` and finish it, twice.
3. Run `start` a third time.

## Expected results

- When a `--merge` start follows a conflict, the system shall exit 0 and print `escalation one_more_round by auto (merge, not counted)`; three such starts record three auto answers, each with `merge: true`.
- When a repair start follows, the system shall print `escalation one_more_round by auto (<n> of 2)` for n = 1, 2.
- When the budget is spent, the system shall refuse the next start with `round budget spent` and append no event.

## Screenshot checkpoints

none: integration case on CLI exit codes and events; no UI surface.
