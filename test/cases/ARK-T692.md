---
id: ARK-T692
title: "ARK-T692 ark test starts no suite and no check while the 1-minute load is above test_max_load, names the load and the limit once, and starts at the limit"
level: integration
technique: "boundary values (load below, at and just above the limit; an integer, a fractional and the default limit) and equivalence classes (a readable load, a missing reading, a bad config value)"
priority: high
risk: "`ark test` starts a suite into a host at load 37 to 117 on 10 cores, so every timing test of the run fails and the failed run costs hours (ARK-499: 3 full tests, about 4 h); or the limit is exclusive and a load equal to it holds; or the default is not the core count; or a fractional limit is refused or truncated; or a missing load reading holds every run forever; or the load reason is printed under the memory prefix, or on every poll; or the load reason enters `holdReasons` and `ark chief state` starts to hold new runs"
status: active
changed_by: 2026-11-18-ARK-515-1
---

## Objective

Prove `ark test` takes no ticket as started, runs no check and no suite while the 1-minute load average is above `test_max_load` of `ark.yml`, prints one `waiting for load` line that names the load and the limit, and runs at once when the load is at or under the limit. The default limit is the core count, a fraction is a valid limit, a missing reading never holds, and `ark chief state` is unchanged.

Gate answers:

1. Protects the `ark test` admission contract of AC1: the hold, its inclusive limit, its default, its line and the `holdReasons` boundary.
2. A regression that fails it: the hold is missing, `>=` instead of `>`, `integer()` for the key, a default other than `availableParallelism()`, a hold on `null`, the `memory` prefix, or a load reason in `holdReasons`.
3. No existing case holds the load (ARK-T187 holds memory; ARK-T365 and ARK-T188 hold the chief state on the 5-minute load and CPU). This case owns the load hold; ARK-T694 owns the recovery and the print cadence at `openTestBudget`; ARK-T695 owns the bare path.
4. The 1-minute load cannot be faked through `PATH` (`os.loadavg()`). The seam is `ARK_FAKE_LOAD_ONE`, read by the default `loadAverages` reader of `cli/host.ts` on every reading (as `ARK_FAKE_LOAD` is read by `ark chief state`, ARK-T365). The reader is the production reader that the detached runner calls, so the case runs the real `ark test` against it, with no export or wrapper.

## Preconditions

- Temp project and temp `ARK_HOME`, one run with a check and one cheap suite whose command writes a marker file; the budget has free cores. The memory and swap readings are healthy (the fake host of ARK-T187), so only the load can hold.
- `ARK_FAKE_LOAD_ONE` is set in the environment of the `ark test` child (the preload sets `0` for the case itself, so the case sets it for each row). It holds a decimal number, or `file:<path>` (a file whose number is read on every reading); a value that is not a number is a reading that failed. This case uses the number form.
- `ark.yml` has `test_max_load: 10` unless the step says another.
- The case runs `ark test` as a real process, in the background for a hold: it waits over three poll intervals, reads `results/runner.out` and the marker, then stops the runner with `ark test <run> --stop` (as ARK-T235 does).
- `os.availableParallelism()` is read by the case for the default row.

## Steps

1. `ARK_FAKE_LOAD_ONE=12.5`, limit 10. Run it in the background; wait over three poll intervals; read the output, the marker and the ticket store.
2. `ARK_FAKE_LOAD_ONE=10`, limit 10 (at the limit). Run it to its end.
3. `ARK_FAKE_LOAD_ONE=3`, limit 10. Run it to its end.
4. Fractional limit: `test_max_load: 7.5`; load 7.5 runs to its end; load 7.6 holds as in step 1.
5. Default: no `test_max_load` key. Load exactly the core count (`availableParallelism()`) runs to its end; load core count plus 0.1 holds as in step 1.
6. Missing reading: `ARK_FAKE_LOAD_ONE=unreadable`, limit 10. Run it to its end.
7. A check that the run lists runs before the suites. Repeat step 1 and read the marker of the check as well as that of the suite.
8. Chief state: with `ARK_FAKE_LOAD_ONE=500` (the 1-minute slot) and the healthy host, run `ark chief state`.
9. Bad value: `test_max_load: "fast"`, then `test_max_load: -1`. Run `ark test`.

## Expected results

- Step 1: the marker is absent while the run waits; the output has exactly one line that starts `ark test: waiting for load` and names both values (`1-minute load 12.5 is above the limit 10`), however many polls pass; no line says `waiting for memory`. The run's ticket is waiting and is not marked `started` (the budget section of `ark chief state` lists it as waiting).
- Step 2: the run starts at once, exit 0, marker written, no `waiting for load` line (inclusive limit).
- Step 3: same as step 2.
- Step 4: load 7.5 starts at once; load 7.6 holds with one line that names `7.6` and `7.5` (the fraction is kept, not truncated to 7).
- Step 5: the default is the core count: equal runs, plus 0.1 holds, and the line names the core count as the limit.
- Step 6: the run starts at once, exit 0, marker written; the output has no `waiting for load` line and the run does not stall (a missing reading does not hold).
- Step 7: neither the check marker nor the suite marker exists while the run waits (every `take()` goes through the hold), and both exist after a run at load 3.
- Step 8: the `## Host` section and the `hold new runs:` line are those of a healthy host: `hold new runs: no`, with no load reason. `ark chief state` prints no `waiting for load`.
- Step 9: each run exits 1 with an error that names `test_max_load`, runs no check or suite, and writes no `test.completed`.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
