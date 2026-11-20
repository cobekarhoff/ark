---
id: ARK-T710
title: "ARK-T710 while another suite runs, ark test holds a suite on CPU use over 90 percent from a fresh sample, ignores the 1-minute load, and runs no check or suite while it waits"
level: integration
technique: "boundary values (CPU 5, 90, 90.1 and 99 percent; load 0 and 30) and equivalence classes (a readable CPU reading, a missing one, the real sampler on a busy and a fresh process)"
priority: high
risk: "The hold still reads the 1-minute load, so a host at 5 percent CPU and a load of 30 (swap and disk waits counted as load) holds every suite (ARK-586); or the hold reads the CPU the lazy way, a plain `reading.cpuPercent`, so a fresh runner process reads null on its first reading and never holds, or averages over the minutes since an earlier reading and holds or admits on a stale figure; or the limit is exclusive (90 holds) or is not 90 as in `ark chief state`; or a missing CPU reading holds every run for ever; or the CPU reason is printed on every poll, or is printed under the memory prefix; or a check or a suite starts while the line says it waits"
status: active
changed_by: 2026-11-20-ARK-586-1
---

## Objective

Prove the hold of `ark test` reads CPU use over a short fresh sample and holds a suite, while another suite runs, only when it is above 90 percent, as the run-start hold of `ark chief state` does. The 1-minute load average does not hold: a host at 5 percent CPU with a load of 30 admits the suite. The line names the CPU figure and the limit once. No check and no suite starts while the run waits.

Gate answers:

1. Protects the hold rule of AC2: its source (CPU use, not load), its limit and its comparison, the missing reading, the print cadence, and that a held run starts nothing.
2. A regression that fails it: the hold still reads the load, `>=` for `>`, a limit other than 90, a hold on `null`, a line for each poll, a first reading that is null in a fresh process, or a check that runs before the hold.
3. ARK-T365 and ARK-T366 prove the `hold new runs:` line of `ark chief state` at the same limit and own that line. ARK-T709 owns the idle exception and runs with nothing else running, so it never shows the figure of the hold. ARK-T694 owns recovery and cadence in process; ARK-T695 owns the bare path. No case holds a suite on a reading of the host in a real runner process.
4. The CPU and the load cannot be faked through `PATH`. The seams are `ARK_FAKE_CPU_PERCENT` (the one of ARK-T365, now also read on the admission path by the reader of `cli/host.ts`) and `ARK_FAKE_LOAD_ONE`, read by the production reader that the detached runner calls: no export or wrapper. Step 6 runs with no CPU seam, so the real sampler of the runner is proven too.

## Preconditions

- Temp project and temp `ARK_HOME`, one run with a check and one cheap suite; each command writes its own marker file. Healthy memory and swap (the fake host of ARK-T187).
- Fresh state per row. Each step below starts from its own temp project, temp `ARK_HOME` (own ticket store and result cache) and marker directory, with no marker and no earlier successful result: an earlier row cannot supply a marker, and ARK-T163's reuse of an unchanged successful suite cannot skip admission. The holder is started anew for each row.
- A holder as in ARK-T709: a real child process that holds 1 core of the budget with a `started` ticket until the case releases it. Every row keeps it alive, so the idle exception of ARK-T709 does not apply and only the hold can wait. A row that passes with the holder absent proves nothing here.
- The case runs `ark test` as a real process: to its end where the suite must start, in the background where it must wait (wait over three poll intervals, read the output, the markers and the ticket store, stop the run with `ark test <run> --stop`).
- `ark.yml` has no `test_max_load` key. `ARK_FAKE_CPU_PERCENT` holds a number; a value that is not a number (`unreadable`) is a reading that failed, as `ARK_FAKE_LOAD_ONE` already treats it.

## Steps

1. Fresh state. `ARK_FAKE_CPU_PERCENT=5`, `ARK_FAKE_LOAD_ONE=30`. Run to its end (the host of the ticket).
2. Fresh state. `ARK_FAKE_CPU_PERCENT=99`, `ARK_FAKE_LOAD_ONE=0`. Run in the background and wait as above; read the marker of the check and that of the suite.
3. Fresh state. `ARK_FAKE_CPU_PERCENT=90` (exactly the limit), `ARK_FAKE_LOAD_ONE=0`. Run to its end.
4. Fresh state. `ARK_FAKE_CPU_PERCENT=90.1`, `ARK_FAKE_LOAD_ONE=0`. Run in the background and wait as above.
5. Fresh state. Missing reading: `ARK_FAKE_CPU_PERCENT=unreadable`, `ARK_FAKE_LOAD_ONE=30`. Run to its end.
6. Fresh state. Real sampler: unset `ARK_FAKE_CPU_PERCENT`, `ARK_FAKE_LOAD_ONE=0`. The case starts one busy-loop child process for each core of the host (`os.availableParallelism()`). Run in the background and wait as above.
7. Stop the runner (`ark test <run> --stop`), the busy loops (by their PIDs) and the holder (release).

## Expected results

- Step 1: the suite starts at once, exit 0, check and suite markers written, no `waiting for` line: the load of 30 does not hold.
- Step 2: no check marker and no suite marker (every `take()` goes through the hold, the check's too); exactly one line that starts `ark test: waiting for CPU` and names `99` and the limit `90` (and no `1-minute load`), however many polls pass; the run's ticket is waiting with no `started` mark; no `waiting for memory` line.
- Step 3: starts at once, exit 0, markers written, no waiting line (inclusive limit: only a value above 90 holds).
- Step 4: as step 2; the line names `90.1`.
- Step 5: starts at once, exit 0, markers written, no waiting line, and the run does not stall (a CPU reading that failed never holds).
- Step 6: one `waiting for CPU` line and no marker while the loops run: a fresh runner process takes its CPU sample at the hold, not a null first reading. Only the hold direction is asserted: an idle-host reading is not, because other runs share the host.
- Step 7: the holder, the loops and the runner are gone; the case leaves no process.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
