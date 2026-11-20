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

- The scratch time-limit hook is a preload file that the case writes into a temp folder and passes to the inner run with `--preload`. It wraps `AbortSignal.timeout`: the k-th call with the argument 20000 (the `passLimit` of `test/bare-test-budget.test.ts`) returns a signal that aborts in a microtask instead of after the limit; every other call is unchanged. It records the count of `AbortSignal.timeout(20000)` calls it saw in a file in the temp folder. The hook is in the case, in no product file and in no export of the test file. The preload is not inherited by the `bun test` children that the inner test starts (a preload is a command-line flag, not an environment variable).
- The inner run is `bun test test/bare-test-budget.test.ts -t "takes its own ticket under the marker of a run that has ended"` in the worktree, started by the case as a child with its own process group and an environment that carries `K` (the call to expire). It reuses the temp `TMPDIR` and `ARK_HOME` rules of the file (the file's own fixture makes its temp folders).
- The case starts every process itself, waits on process exit and on files, and stops a left-over inner run by its own pid (never by name).
- A microtask runs before any exit of a child is read, so a wait on a child that still runs always rejects with its name. A wait that was already settled when its limit is made passes the race and prints no `no <name>` line, so the case asserts only on the runs that failed. The waits on the exit of a child that the test starts are all pending when they start: the exit of the first run after the gate opens, the exit of the run that takes the free cores after the writer is released, the exit of the waiting run right after the case kills its group (the kill and the wait are in one synchronous step, so the exit is not yet read), and the exit of the holder after its release.

## Steps

1. Run the inner test with `K` = 0 (no call expires). It passes. Read the count N of `AbortSignal.timeout(20000)` calls that the hook recorded.
2. For each k in 1..N run the inner test again, all N runs together, with the k-th call expired. A run either fails or passes. For each run that fails, read the single line `no <name> within 20000 ms` from its output and keep the pair (k, `<name>`). A run that passes is not read: its wait had already settled.
3. From the failed runs keep the pairs whose name starts with `exit of` (waits on the exit of a child or of a holder).
4. Remove every temp folder and left-over process of the inner runs.

## Expected results

- Step 1: exit 0 and N is 3 or more.
- Step 2: every run that fails prints exactly one `no <name> within 20000 ms` line, and that line is the failure of the run.
- Step 3: exactly four failed runs carry an `exit of ...` name (the first run, the run that takes the free cores, the waiting run and the holder), and the four names differ. A name that says `exit of the child` on two or more k is a failure.
- At the base commit (c3be2c8, with the race of ARK-T715) step 1 fails first: the unexpired inner run hangs on the FIFO and exits 1, so no name is read. The check of the names is proved by a mutation at head (the FIFO fix kept, two names set back to the same string): step 3 fails with the duplicated name.

## Screenshot checkpoints

none: runner output and files, no UI.
