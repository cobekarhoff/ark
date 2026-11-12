---
id: ARK-T267
title: ARK-T267 Two hubs for the same repo that start together give the lock to exactly one, and the other refuses and names its port
level: integration
technique: race (two starts released at the same moment), repeated 20 rounds
priority: high
risk: both hubs get the lock and two hubs serve one repo; or both refuse; or the loser refuses before the winner wrote its port and prints no port; or the loser dies with EADDRINUSE and a non-zero exit so the LaunchAgent restarts it in a loop
status: active
changed_by: 2026-11-11-ARK-420-1
---

## Objective

Prove that the exclusive lock gives exactly one of two simultaneous hubs the repo, and that the other refuses as ARK-365 defined. Serves ARK-420/AC2.

Expected: When two hubs for the same repo start at the same time, exactly one shall get the lock, and the other shall refuse, name the port of the hub that runs, and exit 0.

## Preconditions

- A scratch `ARK_HOME` and a repo path used as the lock key.
- Real `bun hub/main.ts` processes with fake `orca`, `plannotator` and `gh` on `PATH`.
- A start file so that both processes are ready before either runs; the start is a single write both see. Round 1 uses port 0 for both; round 2 uses the same fixed free port for both (rounds alternate).
- No assumption about the libc name or the operating system.

## Steps

Repeat 20 rounds, each with a fresh `ARK_HOME` and no lock file:

1. Spawn hubs A and B, held back by the start file. Release them together.
2. Wait up to 5 s until one hub prints its port and the other exits.
3. Read the exit code and output of the exited hub, then check the running hub answers a request on its port.
4. Stop the running hub with SIGTERM.

## Expected results

- In every round exactly one hub stays up and answers on its port; the other has exited.
- The exited hub exits with code 0 and its output names the port of the running hub (the number matches the one the running hub printed), never `undefined`, empty or a different port.
- No round ends with two hubs up or with none up.
- With the fixed port, the loser still exits 0 with the refusal (no EADDRINUSE crash).

## Screenshot checkpoints

none: process and exit-code assertions only
