---
id: ARK-T114
title: ARK-T114 a waiter file of an ended pid blocks nobody
level: integration
technique: equivalence classes (live waiter versus ended-pid waiter) on a free lock
priority: high
risk: a leftover waiter file of a crashed run with an earlier since blocks every later ark test for ever
status: active
changed_by: 2026-11-08-ARK-396-1
---

## Objective

Prove that a waiter file whose pid has ended does not hold back a newer `ark test`.

## Preconditions

- Temp ARK_HOME with one run and a free lock.
- An ended pid: a spawned process (for example `true`) that has exited. Its file `test-waiters/<pid>.json` holds `{ run, pid, since }` with a `since` earlier than now.

## Steps

1. Write the ended-pid waiter file.
2. Run `ark test` for the newer run to the end.

## Expected results

- The newer `ark test` shall take the free lock without waiting: its output has no `waiting for` line, and the suite log has its `start` line.
- The newer `ark test` shall exit and leave no lock directory behind.

## Screenshot checkpoints

none: integration case on lock files and process output.
