---
id: ARK-T249
title: ARK-T249 Hubs that start at once on a lock left by a dead pid give the lock to exactly one, and every other one names it
level: integration
technique: state transition (dead-pid lock, 12 simultaneous claimants), repeated 12 rounds
priority: high
risk: Two hubs both see the dead pid, both take over the lock, and two hubs serve one Ark repo
status: retired
retired_reason: the dead-pid lock and its recovery are deleted; ARK-T267 covers simultaneous starts
changed_by: 2026-11-11-ARK-420-1
---

## Objective

Prove that when many hubs start at once on a lock file left by a dead pid, exactly one owns the lock and the others name its owner. Serves ARK-365.

Expected: When hubs start at once on a lock of a dead pid, the system shall give the lock to exactly one hub.

## Preconditions

- A scratch `ARK_HOME` and a lock file for the repo that holds a dead pid.
- 12 child processes, each ready to call `acquireLock` and held back by a start file.

## Steps

1. Create the start file so all 12 children call `acquireLock` at the same time.
2. Read each child's answer and the lock file.
3. Repeat 12 rounds with a fresh dead-pid lock.

## Expected results

- Exactly one child gets `null` (it owns the lock).
- The lock file holds the pid of that child.
- Every other child gets a holder with the pid of the owner.

## Screenshot checkpoints

None. There is no screen to check.
