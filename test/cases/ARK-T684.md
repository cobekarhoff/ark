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

- Same fixture as ARK-T683: temp `ARK_HOME`, project `p` with `test_budget_cores: 3`, scratch git repo with the repo preload and marker-writing test files `a`, `b` and `c` under `test/`, `ARK_FAKE_HOST` and PATH shims.
- Same built environment as ARK-T683 for every `bun test` the case starts: the environment of the case minus the `ark test` marker, `BUN_TEST_WORKER_ID`, `JEST_WORKER_ID`, `ARK_PROJECT` and `ARK_HOME`, then `ARK_HOME` set to the temp folder. Only the marker row (step 2) adds the marker back, and only steps 3 and 5 set `ARK_PROJECT=p`.
- Holder: a real child process that holds 3 of 3 cores until the case removes its release file.
- For step 3: a temp run folder with a worktree of the scratch repo and a base commit (the fixture the `ark test` cases use), `ark.yml` with one cli suite whose `command` is `bun test test --parallel=<cores>` asking 3 cores and has no `base_files`. The suite takes the whole budget; no outer holder. `ark test` runs with `ARK_PROJECT=p` in its environment, so the children find the project by that variable even where their cwd is the `ark-base-*` checkout under the temp folder; a path match could not prove the marker there.
- For step 5: a second scratch repo `nested/` outside the first repo (its own `bunfig.toml` preload and one file that writes `nested-ran`), so the nested run never contains the file that starts it. The first repo has one test file `spawn` that runs `bun test --parallel=2` with cwd `nested/` through `Bun.spawn`, awaits it, then copies the ticket files of the store to `store-after-nested`.
- No sleeps: events only (output line, marker file, exit). A deadlock shows as the case's own test timeout.

## Steps

1. With the holder holding all 3 cores, run `bun test test/a.test.ts` and `bun test test/a.test.ts test/b.test.ts` in the scratch repo, cwd the project `workspace` (the project is found; only the file argument can excuse the wait). Wait for exit.
2. In the same state, run `bun test test --parallel=3` once with the marker environment variable that `ark test` sets (copy the name from `run()` in `cli/test-run.ts`) and once without it (control). Read the control's waiting line and markers, then release the holder and wait for its exit.
3. Run `ark test` for the run of the preconditions. Wait for it to end. Read the log of the suite, the base run and the census run (the three runs of the whole `command`) and the ticket store while it runs and after.
4. Check that the base run and the census run each started the whole `command` (the base run through `runAtBase`, the census at the pristine base): their logs show the marker files of the fake suite written by that run.
5. With `ARK_PROJECT=p`, hold the budget with a bare `bun test --parallel=3` in the first repo (it takes all 3 cores through its own ticket and runs `spawn`). Wait for both runs to exit.

## Expected results

- Step 1: both runs start at once with the budget full; the markers show the files ran; no waiting line; the ticket store gains no `bun test` ticket.
- Step 2: with the marker the run starts at once and prints no waiting line; the control run prints one waiting line and runs no file until the release.
- Step 3: `ark test` ends with no hang; the suite holds exactly one ticket of its own; no log of the head suite, base run or census run has a bare-run waiting line; the store never has a `bun test` ticket.
- Step 4: the base run and the census run each ran the fake suite files.
- Step 5: the nested run starts at once and prints no waiting line, `nested-ran` exists, and both runs exit 0. `store-after-nested` holds exactly one ticket (the outer run's, label `bun test`) and none for the nested run.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
