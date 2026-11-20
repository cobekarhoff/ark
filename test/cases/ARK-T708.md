---
id: ARK-T708
title: ARK-T708 a bun test worker whose parent was killed exits by itself within 10 s, and a worker with a live parent, a serial bun test run and a run started with parent pid 1 keep running
level: integration
technique: state transition (parent alive, parent killed) and equivalence classes (--test-worker, serial coordinator, coordinator that was started with ppid 1)
priority: high
risk: workers of a killed `bun test --parallel` stay asleep with parent pid 1 for hours (ARK-515 left 81 of them); or the watch in the preload that runs in every bun test process exits a worker whose parent is alive, or a serial run or a run that the host started with ppid 1 (a launchd job, `nohup`, a container), and the suite fails with no test failure
status: active
changed_by: 2026-11-19-ARK-569-1
---

## Objective

A real `bun test --parallel=2` whose coordinator is killed by SIGKILL leaves no worker alive 10 s later. While the coordinator is alive, no worker is stopped by the watch.

## Preconditions

- A scratch repo with the repo's `bunfig.toml` preload and these test files under `test/`: `hold` writes its own pid and `process.ppid` to `pids-<n>` and then blocks reading a named pipe the case holds open; `long` runs 12 s (longer than the watch interval and the 10 s limit), writing a tick file each second, then passes. Environment built as in ARK-T684 (no marker, `ARK_FAKE_LOAD_ONE=0`, no project, so no budget wait).
- No sleeps in the waits: the case waits for events (the `pids-*` files, `kill -0` polling with a bound). The only timed wait is the 10 s limit of step 2 and the 12 s of `long`, which is the observation.
- The case started every process and stops each by pid when it ends.

## Steps

1. Start `bun test --parallel=2` over `hold` files (two files, so two workers). Wait until both `pids-*` files exist: read the two worker pids and check each one's ppid is the coordinator's pid.
2. Kill the coordinator with SIGKILL by its pid. Poll `kill -0` for both worker pids with a 10 s limit counted from the kill.
3. Control, parent alive: start `bun test --parallel=2` over two copies of `long`. Wait for the exit. Read the tick files.
4. Control, serial run with ppid 1: start `bun test test/long.test.ts` through a double fork (`sh -c '(bun test ... &)'`, so its ppid becomes 1) and wait until its result file exists.
5. Release the pipe of step 1's files if a worker is still alive after step 2 (cleanup by pid, never a name pattern).

## Expected results

- Step 1: two workers, each with ppid equal to the coordinator.
- Step 2: both worker pids are gone within 10 s of the kill. At the base commit they are still alive after 10 s, so the case fails there.
- Step 3: exit 0, every `long` wrote its 12 ticks; no worker stopped.
- Step 4: the serial run (itself not a `--test-worker`) passes with its 12 ticks even though its ppid is 1.

## Screenshot checkpoints

none: no UI. The surface is process state.
