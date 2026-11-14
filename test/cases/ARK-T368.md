---
id: ARK-T368
title: ARK-T368 Home lists the unread question or escalation of a live worker as waiting on the human, and not those of a finished worker or a read message
level: e2e
technique: equivalence classes of message (question or escalation, live or finished worker, read or unread)
priority: high
risk: "a question of a finished worker or a read message keeps the human waiting, or a live worker's escalation is missing from Home and from the Needs me count"
status: active
changed_by: 2026-11-13-ARK-433-1
---

## Objective

Prove that Home shows a `waiting` row for each unread question or escalation of a worker that still runs, names the task, and drops those of a finished worker and read messages.

Expected: Home shall list an unread question and an escalation of live workers as waiting and shall not list one of a finished worker.

## Preconditions

- A building run; three workers: two running (`ctx_live`, `ctx_other`) and one succeeded (`ctx_done`).
- Messages: an unread question of `ctx_live`, an unread escalation of `ctx_other`, an unread question of `ctx_done`, and a read question of `ctx_live`.
- The hub runs on the frozen clock.

## Steps

1. Open Home.
2. Count the `waiting` rows and read each text.
3. Read the Needs me heading.

## Expected results

- 2 rows: "asked the run lead: which port?" naming `hub-server`, and "blocked: tests will not run" naming `hub-tests`.
- No row for "finished worker asks" or "already read".
- The heading reads "Needs me · 2".

## Screenshot checkpoints

none: the case checks text, counts and attributes, not appearance.
