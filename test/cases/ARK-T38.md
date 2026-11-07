---
id: ARK-T38
title: ARK-T38 ark test takes over a lock whose holder process has ended, at once and with one message
level: integration
technique: equivalence classes (dead holder against no lock), error guessing (no lock at all)
priority: high
risk: a crashed `ark test` (kill -9, power loss) leaves its lock and every later `ark test` waits for ever; or the takeover message prints when no lock existed, or takeover waits out a timeout instead of acting at once
status: active
changed_by: 2026-11-06-ARK-343-1
---

## Objective

Prove that a lock naming a dead pid is taken over at once with `took over a stale ark test lock of pid <pid>`, and that a live holder is not taken over. Serves ARK-343/AC2.

Expected: When the holder pid of the lock no longer exists, the system shall take over the lock without waiting and print `took over a stale ark test lock of pid <pid>` once; when no lock exists, the system shall not print that line.

## Preconditions

- A temporary `ARK_HOME` with a fixture project and one fixture run whose suite appends `start <ms>` to a log file.
- A dead pid: spawn a short child, wait for it to exit, keep its pid.

## Steps

1. Write the lock in the format `ark test` writes, with the dead pid and a run name. Run `ark test` for the fixture run and measure the time from start to `start` in the log.
2. Run `ark test` again with no lock present.

## Expected results

- Step 1: exit 0, the suite starts, the stdout holds `took over a stale ark test lock of pid <dead pid>` once and no `waiting for` line, and the start comes in well under the time one wait poll plus a margin would allow (under 2 s).
- Step 2: no `took over` line.

## Screenshot checkpoints

None, CLI output.
