---
id: ARK-T266
title: ARK-T266 A hub killed with SIGKILL at any point of taking the lock never blocks the next hub
level: integration
technique: state transition (killed after each real stage of acquireLock) and random-delay fault injection against a real hub
priority: high
risk: a hub killed while it holds part of the lock (file opened, flock taken, JSON not yet written, JSON written) leaves state that makes every later hub wait or refuse; or a spawned child inherits the lock fd and keeps the lock after the hub dies; or a dead pid in the file reads as a live hub
status: active
changed_by: 2026-11-11-ARK-420-1
---

## Objective

Prove that the lock is released by the operating system on SIGKILL, so no kill point leaves a lock that blocks the next hub. Serves ARK-420/AC1.

Expected: When a hub is killed with SIGKILL at any point of taking the lock, also during a start that follows an earlier dead hub, the system shall start the next hub for the same repo within 5 seconds with no manual step.

## Preconditions

- A scratch `ARK_HOME` and a repo path used as the lock key.
- `hub/lock.ts` exports its acquisition stages as real functions, `openLockFile`, `tryFlock` and `writeHolder`. `acquireLock` is their composition and is their production caller. Product code does not change for the test.
- A child script (a test file) that imports those stage functions and runs the real ones in order up to a named stage, prints `ready`, then waits for ever. It implements none of open, flock or write itself, so the real stage code holds the real state when the kill lands. No env var or hook is added to production.
- The next hub is a real `bun hub/main.ts` with fake `orca`, `plannotator` and `gh` on `PATH`, port 0, as in ARK-T242.
- The lock library is chosen by platform in product code (`libc.dylib` on darwin, `libc.so.6` on Linux). The case never names a library, so it passes on macOS and Linux CI alike. No step uses `flock(1)` (absent on macOS).

## Steps

Part A, fixed stages. For each kill point K:

1. Start the child script to stop after K. Wait for `ready`.
2. Kill the child with SIGKILL. Wait for it to exit.
3. Start a real hub for the same repo with port 0 and time it.
4. Read its port, request it once, and stop it with SIGTERM.

Kill points:

- K1: after `openLockFile`, before `tryFlock`.
- K2: after `tryFlock`, before `writeHolder` (lock held, file empty).
- K3: after `writeHolder` (lock held, JSON written).
- K4: takeover. Run K3 and kill it, then start a second child that runs to K2 on the same repo and kill it.
- K5: after `tryFlock` the child spawns `sleep` through `Bun.spawn`; kill only the child, leave the `sleep` alive. Kill the `sleep` after step 4.
- K6: no lock held; the file holds the pid of a live unrelated process (`sleep`) and a port.

Part B, a real hub killed at random times. Repeat 30 rounds:

1. Start a real hub for the repo. After a random delay of 0-150 ms (seeded, seed printed on failure), SIGKILL it, whether or not it printed a port.
2. Start the next real hub, as in steps 3-4 above. Assert it starts.

## Expected results

- Part A, every K: the next hub starts, prints its port and serves the request within 5 s of the kill.
- K5: the next hub starts although the child process of the killed process is alive (the fd is not inherited).
- K6: the next hub starts (a live pid in the file is not a lock).
- Part B, every round: the next hub starts within 5 s, whatever the kill time.
- The test deletes nothing in `ARK_HOME`.

## Screenshot checkpoints

none: process and exit-code assertions only
