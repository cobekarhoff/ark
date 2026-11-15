---
id: ARK-T683
title: ARK-T683 a whole-suite bun test started outside ark test waits for the shared test budget, prints one waiting line, and starts only after the budget is released
level: integration
technique: state transition (budget full, released, one file still running) with equivalence classes on the whole-suite command line (no path, directory, --parallel=N) and on the way to the project (ARK_PROJECT, run worktree path)
priority: high
risk: A bare `bun test` or `bun test test --parallel=3` starts its files while `ark test` runs hold the budget (host load 20 to 63, timing failures in other runs); or the wait fires once per file in a `--parallel` run, takes one ticket per file, frees the ticket when any worker other than the one that still runs a file ends, or never shows its line; or a validator's `bun test` inside a run worktree finds no project and skips the wait
status: active
changed_by: 2026-11-15-ARK-513-1
---

## Objective

Prove a `bun test` of the whole suite (no path argument, or a directory argument) started outside `ark test` takes its cores from `test_budget_cores` through the real ticket store, runs no test file until the cores are free, and keeps the ticket until its last file ends.

Expected: with the budget full, no file runs and one waiting line shows; after the holder ends, the run holds one ticket while a file is still running, and the ticket is gone after the run exits.

## Preconditions

- Temp `ARK_HOME` with project `p` whose `ark.yml` sets `test_budget_cores: 3` and `workspace` to a scratch git repo.
- The scratch repo has the repo's `bunfig.toml` preload and four test files under `test/` (a fake suite): `a`, `b` and `c` each open the write end of a named pipe `alive-<name>` and keep it open (the case opened the read ends before the run; the descriptor closes when the file's worker exits), then write a marker file `ran-<name>` that holds `process.pid`, and nothing else; `gate` does the same with `alive-gate`, writes `started-gate` with its `process.pid`, blocks reading a named pipe (`gate`) that the case writes to later, then writes `ran-gate`. The `ARK_FAKE_HOST` and PATH shims come from the outer preload, so memory admission does not hold the run. A worker's exit is the end-of-file of its `alive-*` pipes: no poll, no sleep.
- The environment of every `bun test` child the case starts is built, not inherited: the environment of the case minus the `ark test` marker (the name `run()` in `cli/test-run.ts` sets), `BUN_TEST_WORKER_ID`, `JEST_WORKER_ID`, `ARK_PROJECT` and `ARK_HOME`; then `ARK_HOME` is the temp folder, and `ARK_PROJECT` is set only in the row that says so. Reason: the case itself may run under `ark test` (the marker would make the child never wait) or under an outer `bun test --parallel` (the worker variables would make a serial child read the command line of its parent).
- The holder is a real child process: `openTestBudget("holder", 3, ...)` and `await budget.take(3)` from `cli/test-lock.ts`, then it blocks on a file the case later removes. Its ticket pid is live.
- No sleeps: the case waits on events (a line read from the child's output, a marker file, process exit).

## Steps

1. Start the holder and wait until its ticket is running (3 of 3 cores).
2. Start `bun test --parallel=3` with no path in the scratch repo (cwd the workspace). Read its output until the waiting-for-budget line shows. Check that no `ran-*` marker and no `started-gate` exists and that the child is alive.
3. Read the ticket store: the bare run has one waiting ticket with label `bun test`, asking 3 cores, with the pid of the `bun test` process the case spawned (the coordinator, not a worker).
4. Run `ark chief state` against the same `ARK_HOME` and read the `## ark test budget` section.
5. Release the holder. Wait until `started-gate` exists and every `ran-*` marker of `a`, `b` and `c` exists. In a `--parallel` row, read the pids in the markers and in `started-gate`; for each file whose pid differs from the `gate` pid, wait for end-of-file on its `alive-<name>` pipe (that worker has exited; the `gate` worker is still alive and still runs `gate`). If every pid equals the `gate` pid (one worker ran all files, so none ended), repeat the row from step 2. In a serial row nothing else is waited for. Read the ticket store and run `ark chief state` again.
6. Write to the named pipe so `gate` ends. Wait for the child to exit. Read its output, the markers and the ticket store, and run `ark chief state` once more.
7. Repeat 2 to 6 for these command lines: `bun test` (no flag, serial: asks 1 core; the holder still holds 3, so it waits; step 5 waits for `started-gate` only), `bun test test --parallel=3` (directory argument, the command line of the `ark.yml` cli suite), `bun test --parallel` (bare flag: Bun asks for the CPU count, so the ticket asks min(CPU count, 3); the case reads the CPU count with `os.availableParallelism()`).
8. Repeat 2 to 6 for `bun test --parallel=3` with cwd a run worktree under `ARK_HOME/projects/p/runs/<run>/workspace` (not the project `workspace`), once with `ARK_PROJECT=p` and once with only the path to find the project.
9. With the holder holding 1 of 3 cores, start `bun test --parallel=2` and write the named pipe at once: it asks 2 and fits.

## Expected results

- Steps 2 and 8: no `ran-*` marker, no `started-gate` and no test output until the release; the output holds exactly one waiting line that says it waits for the test budget, shown while the child still waits (not only at the end); not one line per test file.
- Step 3: one ticket with label `bun test`, waiting; its pid is the pid of the spawned `bun test` and alive.
- Step 4: chief state shows `- waiting: bun test (pid N), 3 cores` with the pid of step 3. This is the reader that the run lead's interim paragraph greps.
- Step 5: in a `--parallel` row at least one worker other than the `gate` worker has exited and the `gate` worker is alive. The ticket store holds exactly one ticket for the invocation (not one per file): started, label `bun test`, the cores asked, the coordinator pid, alive, while `gate` still runs. Chief state shows `- running: bun test (pid N)` with the same pid. A ticket freed by any other worker's exit fails here. The ticket's creator is a worker's preload, and a creator that registers exit cleanup is ARK-T155 step 9 ("a helper writes no exit cleanup"), not this step.
- Step 6: all four files ran exactly once; the child exits 0; the ticket store has no `bun test` ticket; chief state shows no `bun test` entry.
- Step 7: the same for each command line; the serial run asks 1 core, the bare `--parallel` run asks min(CPU count, 3), never above the budget.
- Step 8: both ways to the project wait the same way.
- Step 9: all files run with no wait and no waiting line (cores fit).

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
