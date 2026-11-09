---
id: ARK-T60
title: ARK-T60 ark test takes over a lock whose holder process has ended, at once and with one message
level: integration
technique: equivalence classes (ticket of an ended pid against no ticket), error guessing (no ticket at all)
priority: high
risk: a crashed `ark test` (kill -9, power loss) leaves its ticket and every later `ark test` waits for ever; or the takeover message prints when no ticket existed, or the takeover waits out a poll instead of acting at once
status: active
changed_by: 2026-11-09-ARK-390-1
---

## Objective

Prove that a budget ticket naming a dead pid frees its cores at once with `took over a stale ark test lock of pid <pid>`. Serves ARK-390/AC1.

Expected: When the pid of a running ticket no longer exists, the system shall free its cores at once and print `took over a stale ark test lock of pid <pid>` once; when no ticket exists, the system shall not print that line.

## Preconditions

- A temporary `ARK_HOME` with a fixture project and one fixture run whose suite appends `start <run>` to a log file, and a budget of 6 cores.
- A dead pid: spawn a short child, wait for it to exit, keep its pid.

## Steps

1. Write a running ticket (`run`, `pid`, `cores` 6, `arrival`, `started`) with the dead pid in the `test-budget` folder. Run `ark test` for the fixture run.
2. Run `ark test` again with no ticket present.

## Expected results

- Step 1: exit 0, the suite starts, the stdout holds `took over a stale ark test lock of pid <dead pid>` once and no `waiting:` line (it started on its first look).
- Step 2: exit 0 and no `took over` line.

## Screenshot checkpoints

None, CLI output.
