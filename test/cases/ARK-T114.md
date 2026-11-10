---
id: ARK-T114
title: ARK-T114 a waiter file of an ended pid blocks nobody
level: integration
technique: equivalence classes (live waiter versus ended-pid waiter) on a free budget
priority: high
risk: a leftover ticket of a crashed run with an earlier arrival blocks every later ark test for ever
status: active
changed_by: 2026-11-09-ARK-390-1
---

## Objective

Prove that a waiting ticket whose pid has ended does not hold back a newer `ark test` and is deleted, while a live older ticket still holds it back.

## Preconditions

- A temporary `ARK_HOME` with one run, a budget of 6 cores and no running ticket.
- An ended pid: a spawned process (`true`) that has exited. Its waiting ticket in `test-budget` holds the earliest `arrival`.
- A live older waiter: a spawned `sleep` (not the test process) with its own waiting ticket and an `arrival` later than the ended ticket but earlier than now.

## Steps

1. Write the ended-pid ticket and the live ticket.
2. Start `ark test` for the newer run. Wait until its stdout holds `waiting: place 2 of 2; running: none`.
3. Kill the live waiter.
4. Wait for the newer `ark test` to end.

## Expected results

- While the live waiter lives, the newer `ark test` shall be in place 2 of 2 (the ended ticket does not count), shall not start its suites and shall keep running; the ended ticket file is gone.
- After the live waiter is killed, the newer `ark test` shall start its suites and exit 0, with a `start` line in the suite log.
- The newer `ark test` shall leave no ticket behind.

## Screenshot checkpoints

none: integration case on ticket files and process output.
