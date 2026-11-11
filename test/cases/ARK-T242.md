---
id: ARK-T242
title: ARK-T242 A second hub on the same Ark repo refuses to start, exits 0, names the port of the running hub, and takes over a lock left by a dead pid
level: integration
technique: state transition (no lock, held lock, dead-pid lock, released lock) and race (two starts at once)
priority: high
risk: a second hub on another port starts (three hubs ran for 28 h); or the refusal exits non-zero so the LaunchAgent `dev.ark.hub` with KeepAlive restarts it in a loop; or a lock left by a killed hub blocks every later start; or a stopped hub leaves its lock behind
status: active
changed_by: 2026-11-11-ARK-365-1
---

## Objective

Prove that one hub runs per Ark repo. Serves ARK-365/AC3.

Expected: Where a hub already runs for the same Ark repo, a second hub shall refuse to start, name the port of the running hub, and exit 0. A lock left by a dead pid shall not block a start.

## Preconditions

- A temporary `ARK_HOME` and a temporary copy of the Ark repo path used as the lock key; a second temporary copy with a different path.
- Fake `orca`, `plannotator` and `gh` on `PATH`.
- Hubs start with `Bun.spawn` on port 0.

## Steps

1. Start hub A on port 0. Read its port P.
2. Start hub B for the same Ark repo with port 0. Capture its output and exit code.
3. Start hub C for the same repo with the fixed port P. Capture the output.
4. Start hub D for a different Ark repo path. Check that it starts and has its own port.
5. Start two hubs for a fresh repo at the same moment. Check that exactly one stays up.
6. Kill hub A with SIGKILL (the lock stays). Start hub E for that repo.
7. Stop hub E with SIGTERM. Check the lock file and start hub F.

## Expected results

- Step 2: hub B exits with code 0 within 5 s, prints a line with the port P and does not listen.
- Step 3: the same refusal text with P and exit code 0.
- Step 4: hub D starts and its port differs from P.
- Step 5: one hub stays up, the other exits 0 and names the port of the first.
- Step 6: hub E starts, takes over the lock and holds its own port.
- Step 7: after SIGTERM the lock is gone and hub F starts.

## Screenshot checkpoints

none: process, call-log and event-stream assertions only
