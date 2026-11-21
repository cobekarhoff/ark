---
id: ARK-T187
title: "ARK-T187 ark test waits for memory on low free memory or high swap, names the reason once, and starts when memory recovers"
level: integration
technique: "boundary values (free memory at, below and above the floor; swap at, below and above the ceiling) and state transition (waiting to started)"
priority: high
risk: "Admission ignores memory, so a swapping host takes more test suites; or the wait prints on every poll; or a reading that fails blocks every test forever instead of admitting with 'memory: unchecked'"
status: active
changed_by: 2026-11-21-ARK-623-1
---

## Objective

Prove the admission of `ark test` (the CPU budget of ARK-390) also holds a suite while free memory is below the floor or swap is above the ceiling, says why in one line, and starts the suite once the reading recovers.

## Preconditions

- Temp project and temp `ARK_HOME` with a run and one cheap suite whose command writes a marker file. The test lock folder is in the temp `ARK_HOME`; the CPU budget has free cores, and no other suite runs in that store, so the CPU hold never applies (it holds only while another suite runs: ARK-T709) and only memory can hold the suite.
- The `host.yml` of the temp `ARK_HOME` sets only `test_budget_cores: 6` (the `startRun` fixture of `test/test-lock.test.ts`), and no host key is in the project's `ark.yml`: the memory defaults 20 and 8 apply. The limits a host file sets are owned by ARK-T769.
- A fake host reading supplied at the real boundary: the commands or file the real reader parses (macOS `memory_pressure` and `sysctl vm.swapusage` on a temp `PATH`, Linux a temp `/proc/meminfo` path), rewritten by the test while `ark test` runs. No hook in product code is added for the memory test.

## Steps

1. Fake reading: 50 percent free, 2 GB swap. Run the real `ark test <run>`.
2. Fake reading: exactly 20 percent free, 8 GB swap (at the limits). Run it.
3. Fake reading: 50 percent free, 8.04 GB swap (the swap prints as 8.0 GB). Run it in the background; wait over three poll intervals; read its output; check the marker file. Rewrite the fake reading to a healthy host and wait for the end.
4. Fake reading: 19 percent free and 8.1 GB swap together. Run it in the background; wait over three poll intervals; read the wait line and the marker file. Rewrite the fake reading to a healthy host and wait for the end.
5. Fake reading fails (command exits 1 or file missing). Run it.

## Expected results

- Step 1: the suite starts at once, exit 0, marker written, no memory line.
- Step 2: the suite starts at once (the limits are inclusive: wait only below the floor and above the ceiling).
- Step 3: the marker is absent while waiting, with exactly one line that names swap and compares the raw reading, not the printed one (8.04 GB prints as `ark test: waiting for memory: swap 8.0 GB is above the 8 GB ceiling`), however many polls pass; after the recovery the suite starts and the run exits 0 with the marker written.
- Step 4: the marker is absent while waiting, with exactly one line that carries the free-memory reason first, then the swap reason (`free 19% is below the 20% floor; swap 8.1 GB is above the 8 GB ceiling`); after the recovery the suite starts and the run exits 0 with the marker written.
- Step 5: the suite starts, exit 0, and the output has `memory: unchecked` once.
- A suite that waits for memory does not mark itself `started` in its lock ticket while it waits (the budget section of `ark chief state` lists it as waiting).

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
