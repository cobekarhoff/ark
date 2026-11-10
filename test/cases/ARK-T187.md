---
id: ARK-T187
title: "ARK-T187 ark test waits for memory on low free memory or high swap, names the reason once, and starts when memory recovers"
level: integration
technique: "boundary values (free memory at, below and above the floor; swap at, below and above the ceiling) and state transition (waiting to started)"
priority: high
risk: "Admission ignores memory, so a swapping host takes more test suites; or the wait prints on every poll; or a reading that fails blocks every test forever instead of admitting with 'memory: unchecked'"
status: active
changed_by: 2026-11-09-ARK-417-1
---

## Objective

Prove the admission of `ark test` (the CPU budget of ARK-390) also holds a suite while free memory is below the floor or swap is above the ceiling, says why in one line, and starts the suite once the reading recovers.

## Preconditions

- Temp project and temp `ARK_HOME` with a run and one cheap suite whose command writes a marker file. The test lock folder is in the temp `ARK_HOME`; the CPU budget has free cores, so only memory can hold the suite.
- `ark.yml` keys `test_min_free_memory_percent` and `test_max_swap_gb` unset (defaults 20 and 8), then set to other values for the last step.
- A fake host reading supplied at the real boundary: the commands or file the real reader parses (macOS `memory_pressure` and `sysctl vm.swapusage` on a temp `PATH`, Linux a temp `/proc/meminfo` path), rewritten by the test while `ark test` runs. No hook in product code is added for the test.

## Steps

1. Fake reading: 50 percent free, 2 GB swap. Run the real `ark test <run>`.
2. Fake reading: exactly 20 percent free, 8 GB swap (at the limits). Run it.
3. Fake reading: 19 percent free, 2 GB swap. Run it in the background; wait over three poll intervals; read its output; check the marker file.
4. Rewrite the fake reading to 50 percent free; wait for the process to end.
5. Fake reading: 50 percent free, 8.1 GB swap. Run in the background, wait over three poll intervals, read output and marker; then rewrite to 2 GB swap and wait for the end.
6. Fake reading: 19 percent free and 8.1 GB swap together. Read the wait line.
7. Fake reading fails (command exits 1 or file missing). Run it.
8. Set `ark.yml` `test_min_free_memory_percent: 10` and `test_max_swap_gb: 12`; fake 15 percent free, 10 GB swap. Run it.

## Expected results

- Step 1: the suite starts at once, exit 0, marker written, no memory line.
- Step 2: the suite starts at once (the limits are inclusive: wait only below the floor and above the ceiling).
- Step 3: the marker is absent while waiting, and the output has exactly one line that names the memory reason and the numbers, for example `ark test: waiting for memory: free 19% is below the 20% floor`, however many polls pass.
- Step 4: the suite starts after the recovery and the run exits 0 with the marker written.
- Step 5: the marker is absent while waiting, with one line that names swap, for example `ark test: waiting for memory: swap 8.1 GB is above the 8 GB ceiling`; after recovery the suite starts, exit 0.
- Step 6: one line carries the free-memory reason first, then the swap reason.
- Step 7: the suite starts, exit 0, and the output has `memory: unchecked` once.
- Step 8: the suite starts, exit 0: the configured limits replace the defaults.
- A suite that waits for memory does not mark itself `started` in its lock ticket while it waits (the budget section of `ark chief state` lists it as waiting).

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
