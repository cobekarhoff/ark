---
id: ARK-T714
title: ARK-T714 each wait for the exit of a child in the ARK-T707 test "takes its own ticket under the marker of a run that has ended" has its own name, so a timeout error says which child did not exit
level: integration
technique: fault injection at each wait in turn (the k-th time limit of the test expires), then equivalence classes on the error names of the runs that failed (one class per wait)
priority: medium
risk: a child of that test hangs in CI (as in PR #265, `bun-shards (1)`, 20470 and 20343 ms) and the log says `no exit of the child within 20000 ms` for any of the first run, the run that takes the free cores, or the waiting run, so the person who reads it cannot tell which child to look at and the hang is not diagnosed
status: active
changed_by: 2026-11-20-ARK-596-1
---

## Objective

Prove that when a wait on the exit of a child times out in the ARK-T707 test "a whole-suite bun test takes its own ticket under the marker of a run that has ended, and waits under it while a new holder holds the cores", the error names which child it was, and that no two waits share a name. The text of the waits is not read: the case makes each time limit of the test expire in a real `bun test` process and reads the error that the runner prints.

One contract, one owner: the names of the exit waits in this one test. The `exit of the child` name that ARK-T683 step 11d asserts (a different wait, `bounded` at the row of the failing wait) is owned by ARK-T683 and is not touched.

## Preconditions

- The scratch time-limit hook is a preload file that the case writes into a temp folder and passes to the inner run with `--preload`. It wraps `AbortSignal.timeout`: the k-th call with the argument 20000 (the `passLimit` of `test/bare-test-budget.test.ts`) is made with 1 ms instead; every other call is unchanged. It records the count of `AbortSignal.timeout(20000)` calls it saw in a file in the temp folder. The hook is in the case, in no product file and in no export of the test file. The preload is not inherited by the `bun test` children that the inner test starts (a preload is a command-line flag, not an environment variable).
- The inner run is `bun test test/bare-test-budget.test.ts -t "takes its own ticket under the marker of a run that has ended"` in the worktree, started by the case as a child with its own process group and an environment that carries `K` (the call to expire). It reuses the temp `TMPDIR` and `ARK_HOME` rules of the file (the file's own fixture makes its temp folders).
- The case starts every process itself, waits on process exit and on files, and stops a left-over inner run by its own pid (never by name).
- A wait can already be settled when its 1 ms limit is made: `bounded` races the wait against the timer, so a settled wait passes and prints no `no <name>` line. The case therefore asserts only on the runs that failed. Two waits are always pending when they start, because the child still has work to do after the wait begins: the exit of the first run after the gate opens, and the exit of the run that takes the free cores after the writer is released. The case relies on those two and on no other.

## Steps

1. Run the inner test with `K` = 0 (no call expires). It passes. Read the count N of `AbortSignal.timeout(20000)` calls that the hook recorded.
2. For each k in 1..N run the inner test again with the k-th call expired. A run either fails or passes. For each run that fails, read the single line `no <name> within 20000 ms` from its output and keep the pair (k, `<name>`). A run that passes is not read: its wait had already settled.
3. From the failed runs keep the pairs whose name starts with `exit of` (waits on the exit of a child or of a holder).
4. Remove every temp folder and left-over process of the inner runs.

## Expected results

- Step 1: exit 0 and N is 3 or more.
- Step 2: every run that fails prints exactly one `no <name> within 20000 ms` line, and that line is the failure of the run.
- Step 3: at least two failed runs carry an `exit of ...` name (the exit of the first run and the exit of the run that takes the free cores are pending when they start), and no `exit of ...` name appears for two different k. A name that says `exit of the child` alone on two or more k is a failure.
- At the base commit only step 3 fails: the exit of the first run and the exit of the run that takes the free cores both print `no exit of the child within 20000 ms`, so that name appears for two different k. Step 2 holds at base.

## Screenshot checkpoints

none: runner output and files, no UI.
