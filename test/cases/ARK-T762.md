---
id: ARK-T762
title: "ARK-T762 a failed bun file runs again alone only once the 1-minute load is below test_budget_cores, waits at most ARK_RETRY_LOAD_WAIT_S, and when the wait runs out still reruns and says it reran under load; an unreadable load does not hold the retry"
level: integration
technique: boundary values (load 2.9 and 3 against a budget of 3), state transition (waiting, load drops, retry) and equivalence classes (the load drops, the load never drops, the reading fails)
priority: high
risk: "the retry starts at once on a loaded host, so the timing failure repeats and fails the suite; or it compares the load with the host core count or with `<=`, so a load equal to the budget does not wait; or the wait has no bound, or a bound that the code does not read from `ARK_RETRY_LOAD_WAIT_S`, so `ark test` hangs while the load stays high; or when the wait runs out the retry is skipped and the flaky file fails the suite; or the rerun under load prints nothing, so a pass under load looks like a pass on an idle host; or each failed file starts its own bounded wait, so a suite with N failed files idles N times the limit while it holds its cores of the test budget; or an unreadable load is treated as high and stalls every retry"
status: active
changed_by: 2026-11-21-ARK-509-1
---

## Objective

Prove that before a failed bun test file runs again alone, `ark test` waits until the 1-minute load is below `test_budget_cores`, that the wait ends at the limit that `ARK_RETRY_LOAD_WAIT_S` sets, and that when the limit is reached the rerun still happens and the output says it reran under load.

## Preconditions

- The fixture of ARK-T164 (`test/detached-runner.test.ts`: `makeFixture`, `bunSuite`, `countedFile`), with a real `ark` process. The fixture's `ark.yml` has `test_budget_cores: 3`. Admission ignores the 1-minute load in every config (ARK-T710), so only the retry reads it.
- Steps 1 to 4: one suite `loaded` (parser `bun`, a `base_command` with `{files}`) with two files:
  - `flaky`: fails on its first head start and passes after it. On each head start it also appends the text of the load file, as it reads it at that start, to a separate file `load-seen` (its counter holds only the side).
  - `stable`: always passes.
- The load comes from the production reader of `cli/host.ts` through `ARK_FAKE_LOAD_ONE`, set in the environment of the `ark test` process. The number form is used, or `file:<load file>` (read on every reading) where the case changes the load during the run. The preload's `ARK_FAKE_LOAD_ONE=0` is overridden for each row. There is no new hook.
- Step 5: one suite `loaded` with two files `first` and `second`, which both fail on their first head start and pass after it.
- A fresh fixture for each row.

## Steps

1. Below the budget: `ARK_FAKE_LOAD_ONE=file:<load file>` with the file holding `2.9`, and `ARK_RETRY_LOAD_WAIT_S=120`. Run `ark test <run>` to its end.
2. At the budget, then the load drops: the load file holds `3`, and `ARK_RETRY_LOAD_WAIT_S=120`. Start `ark test <run>` in the background and read its stdout as it comes. Wait, with a limit, for the line that says the retry of suite `loaded` waits for the load. Then read the `flaky` counter. Write `2.9` to the load file and wait for the process to exit.
3. The load never drops: `ARK_FAKE_LOAD_ONE=50` and `ARK_RETRY_LOAD_WAIT_S=1`. Start `ark test <run>` with a limit of 90 s on the process.
4. The reading fails: `ARK_FAKE_LOAD_ONE=unreadable` and `ARK_RETRY_LOAD_WAIT_S=120`. Run `ark test <run>` to its end, with a limit of 60 s on the process, half the 120 s wait limit.
5. Two failed files: `ARK_FAKE_LOAD_ONE=50` and `ARK_RETRY_LOAD_WAIT_S=1`. Run `ark test <run>` to its end, with a limit of 90 s on the process, and count the `retry waits for load` and `reran under load` lines of its output. No assertion reads the clock.

## Expected results

- Step 1: exit 0. `flaky` starts twice at head, and its second start read `2.9`. No line says the retry waits for the load, and no line holds `under load`. The suite line lists `test/flaky.test.ts` as flaky.
- Step 2: a line names the suite `loaded`, the load and the budget `3`, and says the retry waits for the load. At that moment the `flaky` counter has 1 start. After the drop, exit 0. `flaky` starts exactly twice, and its second start read `2.9`, not `3`: the retry ran after the drop. No line holds `under load`, and the file is listed as flaky.
- Step 3: the wait line is printed. Then the retry runs: `flaky` starts twice and the process exits 0, within the 90 s limit, with the file listed as flaky. A line after the wait line names `loaded` and holds `under load`. The default wait of 3 minutes (180 s) exceeds the 90 s limit, so a wait with no bound, or with a bound that the code does not read from `ARK_RETRY_LOAD_WAIT_S`, fails this step.
- Step 4: the retry runs and `flaky` starts twice. Exit 0 with the file listed as flaky, within the 60 s limit: an unreadable load is no reason to wait, so the retry does not hold for the 120 s limit.
- Step 5: exit 0. `first` and `second` each start exactly twice at head. The output holds exactly one `retry waits for load` line and exactly one `reran under load` line: the suite waits once, before its first retry, and the second file runs at once. Both files are listed as flaky. A wait before each file prints each line twice.

## Screenshot checkpoints

none: an integration case on CLI output and processes; no UI surface.
