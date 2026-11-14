---
id: ARK-T397
title: ARK-T397 multiple strategies wait for a valid card choice or abort
level: integration
technique: "state transition (planning -> awaiting_strategy -> planning or closed) with an invalid input on the open gate (a card id that is not in the record)"
priority: high
risk: "a record with 2 or more cards goes straight to planning with no human choice; the gate takes a card id that is not in the record and the plan builds on a strategy that does not exist; or the human cannot abort at the gate, so the run cannot close"
status: active
changed_by: 2026-11-13-ARK-332-1
---

## Objective

Prove that when `strategies.md` holds 2 cards, `ark strategy record` puts the run in `awaiting_strategy`; the gate refuses a card id that is not in the record and lists the valid ids; a valid card id answers it and the run goes to `planning`; and `abort` closes the run.

## Preconditions

- A temp ARK_HOME with a project `demo` (a git workspace, one integration suite, roles with omp models) and a run started from a local ticket `ARK-173`. The criteria gate is accepted and an evaluation is recorded.
- A `strategies.md` of 2 valid cards: `S1` and `S2` (`S2` with `Recommended: no`).
- Real `ark` as a child process.

## Steps

1. Run `ark strategy record <run>`. Read the phase in `state.json`.
2. Run `ark gate record <run> strategy S9`.
3. Run `ark gate record <run> strategy S2`. Read the phase.
4. In a second run, written the same way: run `ark strategy record`, then `ark gate record <run> strategy abort`. Read the phase.

## Expected results

- When the record holds 2 cards, `ark strategy record` shall exit 0 and the phase shall be `awaiting_strategy`.
- When the card id is not in the record (`S9`), the gate shall exit 1 and the error shall list the valid ids `S1, S2`.
- When a valid card id (`S2`) is recorded, the gate shall exit 0 and the phase shall be `planning`.
- When `abort` is recorded at the open gate, the gate shall exit 0 and the phase shall be `closed`.

## Screenshot checkpoints

none: a CLI case, no screen.
