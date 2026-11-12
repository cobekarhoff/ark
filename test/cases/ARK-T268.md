---
id: ARK-T268
title: ARK-T268 A live hub that is stopped with SIGSTOP keeps its lock, and serves again after SIGCONT
level: integration
technique: state transition (running, stopped, continued)
priority: high
risk: the lock is judged by liveness of a pid or by an answer from the hub, so a stopped hub looks dead and a second hub takes over (two hubs on one repo); or the second hub waits on the lock for ever instead of refusing; or the first hub does not serve after SIGCONT
status: active
changed_by: 2026-11-11-ARK-420-1
---

## Objective

Prove that a stopped but live hub still holds the lock, and that the refusal reads the port from the file, not from the stopped hub. Serves ARK-420/AC3.

Expected: While a hub is stopped with SIGSTOP, the system shall keep its lock so that a second hub for the same repo refuses; after SIGCONT the first hub shall serve again.

## Preconditions

- A scratch `ARK_HOME` and a repo path used as the lock key.
- Real `bun hub/main.ts` processes with fake `orca`, `plannotator` and `gh` on `PATH`, port 0.
- Works the same on macOS and Linux CI: the test uses only signals and the product lock, with no libc name.

## Steps

1. Start hub A. Read its port P and check it answers a request.
2. Send SIGSTOP to hub A. Check the process is stopped (a request to P times out).
3. Start hub B for the same repo with port 0 and a 5 s timeout. Capture output and exit code.
4. Send SIGCONT to hub A.
5. Send a request to P.
6. Start hub C for the same repo and capture its output. Stop hub A with SIGTERM.

## Expected results

- Step 3: hub B exits by itself within 5 s (it is not killed by the timeout) with code 0, and its output names the port P.
- Step 5: hub A answers on P.
- Step 6: hub C refuses with P (A kept the lock through the stop and the continue).
- Hub B never listens.

## Screenshot checkpoints

none: process and exit-code assertions only
