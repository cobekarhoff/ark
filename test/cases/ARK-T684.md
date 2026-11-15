---
id: ARK-T684
title: ARK-T684 bun test with a test file argument and every whole suite that ark test starts never wait for the budget a second time
level: integration
technique: equivalence classes (file argument, ark test whole-suite child, nested run inside a held bare run, whole suite with no marker) and decision table on the marker
priority: high
risk: A single-file `bun test test/<file>.test.ts` waits behind a full budget; or `ark test` marks too few of its children, so a whole-suite child (the head suite, or the base and census run of a suite with no `base_files`) waits on cores its own run holds (deadlock); or a test inside a held bare run starts a nested whole-suite `bun test` that waits on the cores its own parent holds (deadlock)
status: active
changed_by: 2026-11-15-ARK-513-1
---

## Objective

Prove the only runs that wait are whole-suite runs with no `ark test` marker: a file run, every whole-suite child of `ark test`, and a nested run inside a held bare run start at once while the budget is full.

Expected: each of them starts at once with no waiting line; the same whole-suite command line without the marker waits (control).

## Preconditions

- Same fixture as ARK-T683: temp `ARK_HOME`, project `demo` with `test_budget_cores: 3`, scratch git repo with the repo preload and marker-writing test files `a`, `b` and `c` under `test/`, `ARK_FAKE_HOST` and PATH shims.
- Same built environment as ARK-T683 for every `bun test` the case starts: the environment of the case minus the `ark test` marker, `BUN_TEST_WORKER_ID`, `JEST_WORKER_ID`, `ARK_PROJECT` and `ARK_HOME`, then `ARK_HOME` set to the temp folder. Only the marker row (step 2) adds the marker back, and only steps 3 and 5 set `ARK_PROJECT=demo`.
- Holder: a real child process that holds 3 of 3 cores until the case writes to its standard input (the release).
- For step 3: a temp run folder with a worktree of the scratch repo and a base commit (the fixture the `ark test` cases use), `ark.yml` with one cli suite whose `command` is `bun test test --parallel=<cores>` asking 3 cores and has no `base_files`. The suite takes the whole budget; no outer holder. `ark test` runs with `ARK_PROJECT=demo` in its environment, so the children find the project by that variable even where their cwd is the `ark-base-*` checkout under the temp folder; a path match could not prove the marker there. The suite has a fourth test file `gate`: only if a named pipe `gate` exists in its own checkout it opens the pipe for reading, then it writes `started-gate` and its working folder, then (when it opened the pipe) blocks reading it until end-of-file, then ends. The case holds a read-write descriptor of the pipe and closes it to release the gate. The case makes the pipe in the head worktree only (it is untracked, so the base and census checkouts have none and their `gate` ends at once) and holds the write end open until it has read the ticket store.
- For step 5: a second scratch repo `nested/` outside the first repo (its own `bunfig.toml` preload and one file that writes `nested-ran`), so the nested run never contains the file that starts it. The first repo has one test file `spawn` that runs `bun test --parallel=2` with cwd `nested/` through `Bun.spawn`, awaits it, then copies the ticket files of the store to `store-after-nested`.
- No sleeps: events only (output line, marker file, exit). A deadlock shows as the case's own test timeout.

## Steps

1. With the holder holding all 3 cores, run `bun test test/a.test.ts` and `bun test test/a.test.ts test/b.test.ts` in the scratch repo, cwd the project `workspace` (the project is found; only the file argument can excuse the wait). Wait for exit.
2. In the same state, run `bun test test --parallel=3` once with the marker environment variable that `ark test` sets (copy the name from `run()` in `cli/test-run.ts`) and once without it (control). For the control, wait until its ticket file exists in the store (a `--parallel` worker's output reaches the pipe only when its file ends, so no line is read before the release), read the ticket and that the markers did not change, then release the holder and wait for its exit.
3. Run `ark test` for the run of the preconditions. Wait until `started-gate` exists in the head worktree (the head suite is running and its `gate` blocks); read the ticket store then. Close the write end of the pipe `gate`, wait for `ark test` to end, then read its output, the log of the head suite and the ticket store again. The base run and the census run have no log that the case reads: a wait in either would never end, because the cores they would wait on belong to this same `ark test`, so the end of `ark test` with exit 0 is the proof for them.
4. Check that the base run and the census run each started the whole `command` (the base run through `runAtBase`, the census at the pristine base): every file of the fake suite appends its working folder to a shared log, so the head worktree has four lines and the one base checkout has eight (census and base run).
5. With `ARK_PROJECT=demo`, hold the budget with a bare `bun test --parallel=3` in the first repo (it takes all 3 cores through its own ticket and runs `spawn`). Wait for both runs to exit.

## Expected results

- Step 1: both runs start at once with the budget full; the markers show the files ran; no waiting line; the ticket store gains no `bun test` ticket.
- Step 2: with the marker the run starts at once, takes no ticket and prints no waiting line; the control run holds one waiting ticket with label `bun test` and runs no file until the release, and its whole output holds exactly one waiting line.
- Step 3: while `gate` blocks, the ticket store holds exactly one ticket, the suite's own (not label `bun test`). `ark test` then ends with exit 0 and no hang (so neither the base run nor the census run waited on the cores of its own run); the output of `ark test` and the log of the head suite hold no bare-run waiting line; after the end the store holds no ticket.
- Step 4: the head worktree ran the four files once, and the base checkout ran them twice (census and base run).
- Step 5: the nested run starts at once and prints no waiting line, `nested-ran` exists, and both runs exit 0. `store-after-nested` holds exactly one ticket (the outer run's, label `bun test`) and none for the nested run.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
