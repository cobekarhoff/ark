---
id: ARK-T365
title: "ARK-T365 ark chief state does not hold new runs on a high load average when CPU use over the sample is below the busy limit"
level: integration
technique: "equivalence classes (load far above the core count with idle CPU, the class the old rule held wrongly) and boundary values (CPU exactly at the 90% busy limit)"
priority: high
risk: "Master Chief holds new runs for hours on a host with idle cores because the hold still keys on the 5-minute load average, which short git and bun processes of `ark test` raise without using CPU (2026-11-12: load 15-33, CPU 2.6%)"
status: active
changed_by: 2026-11-13-ARK-434-1
---

## Objective

Prove `ark chief state` prints `hold new runs: no` when the 5-minute load is far above the core count and the sampled CPU use is below the busy limit, and still shows the load.

## Preconditions

- Temp project and temp `ARK_HOME`, no test lock tickets, no live Orca.
- Healthy memory, swap and disk through the fake host of ARK-T187 (50 percent free, 2 GB swap, disk above its limit).
- Test seam of `chief state`: `ARK_FAKE_CPU_PERCENT` replaces the CPU reading of the ~1 s sample, and `ARK_FAKE_LOAD` replaces the 5-minute load. They are read only by `ark chief state`. `os.cpus()` and `os.loadavg()` cannot be faked through PATH. The busy limit is the constant 90 percent.
- The load is 500, which is above the core count of any host, so the old load rule would hold. The ticket's 22 on 10 cores is a load over the core count; 500 keeps the case failing before the change on any machine.

## Steps

1. `ARK_FAKE_LOAD=500`, `ARK_FAKE_CPU_PERCENT=5`. Run the real `ark chief state`.
2. `ARK_FAKE_LOAD=500`, `ARK_FAKE_CPU_PERCENT=90` (exactly the limit). Run it again.

## Expected results

- Step 1: the Host section still shows the load (`load (5 min)` with 500), and the last line of the section is exactly `hold new runs: no`. There is exactly one `hold new runs:` line and it names no load.
- Step 2: `hold new runs: no` (the limit is crossed only beyond its value, as for the other reasons).

## Screenshot checkpoints

None. The surface is CLI output; no screenshot applies.
