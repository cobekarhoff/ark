---
id: ARK-T230
title: ARK-T230 The `--verified-by` amend is refused in merge_requests_open and closed, and with an unknown criterion or no reason
level: integration
technique: state transition over run phases (building, escalation, merge_requests_open, closed) plus equivalence classes of the other preconditions (unknown criterion, missing or blank reason)
priority: high
risk: a lead rewrites the proof list of a run whose MR is already open or merged, so the MR evidence and the ticket disagree; or the new form skips a refusal that the text form has
status: active
changed_by: 2026-11-10-ARK-361-1
---

## Objective

Prove that the new form has the same phase, criterion and reason refusals as the text form, before ticket.md is touched. Serves ARK-361/AC2.

Expected: If the run is in merge_requests_open or closed, then the system shall refuse the `--verified-by` amend, name the phase, and leave ticket.md and the event log unchanged.

## Preconditions

- A temporary `ARK_HOME`, project and git repo, as in `test/criteria-amend.test.ts`.
- Runs in building, escalation, merge_requests_open and closed, each with active case files for the ids used.

## Steps

1. In each run run `ark criteria amend <run> AC1 --verified-by ARK-T2 --reason "renumbered"`.
2. In the building run run it with criterion `AC9`.
3. In the building run run it with no `--reason`, then with `--reason "  "`.
4. Read ticket.md and the event log after each.

## Expected results

- Building and escalation succeed.
- merge_requests_open and closed exit non-zero, the message names the phase and says criteria cannot be amended; no event, ticket.md byte-identical.
- Unknown criterion: refused, names AC9 and lists the real criteria; nothing changes.
- Missing or blank reason: refused; nothing changes.

## Screenshot checkpoints

none: CLI and file assertions only
