---
id: ARK-T232
title: ARK-T232 A `--verified-by` amend keeps the manual answers of every criterion
level: integration
technique: state transition (manual answer recorded, then amend) over a manual criterion and a non-manual criterion
priority: high
risk: the reducer clears `manual:<id>` for every criteria.amended event, so a renumber forces the human to answer the same manual gate again (ARK-319 answered AC4 twice)
status: active
changed_by: 2026-11-10-ARK-361-1
---

## Objective

Prove that an amend of only the proof list does not clear a manual answer. Serves ARK-361/AC4.

Expected: When a criterion's verified_by list is amended with no text change, the system shall keep the manual answers of all criteria, and the run shall not list a text amendment.

## Preconditions

- A temporary `ARK_HOME`, project and git repo; a run in building with AC1 `manual: true` (answered `ok` with a note) and AC2 `method: test` with a list.
- Active case files for the new ids.

## Steps

1. Amend AC1 `--verified-by` to new ids with a reason.
2. Amend AC2 `--verified-by` the same way.
3. Run `ark status <run>` and read the gate state and `amended_criteria` (or the plan.md Amended criteria section after `ark plan check` in a pre-approval run).

## Expected results

- The manual answer of AC1 is still `ok` with its note after both amends.
- No entry in Amended criteria has old text equal to new text; the verified_by amends appear, if at all, only as a list change.
- An old-format `criteria.amended` event (no `verified_by_*` fields) in another run still clears the answer.

## Screenshot checkpoints

none: CLI and state assertions only
