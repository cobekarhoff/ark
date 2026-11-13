---
id: ARK-T366
title: "ARK-T366 ark chief state holds new runs and names the measured CPU use when CPU use over the sample is above the busy limit"
level: integration
technique: "boundary values (CPU just above the 90% busy limit) and equivalence classes (busy CPU with healthy memory, swap and disk)"
priority: high
risk: "A busy host starts more runs because the CPU reason is missing, is skipped when the first reading is null (one-shot process has no delta), or does not print the measured value Master Chief needs to explain the hold"
status: active
changed_by: 2026-11-13-ARK-434-1
---

## Objective

Prove `ark chief state` ends the Host section with one `hold new runs:` line that names the measured CPU use and the busy limit when the sampled CPU use is above 90 percent.

## Preconditions

- Same as ARK-T365: temp project, temp `ARK_HOME`, no lock tickets, no live Orca, healthy memory, swap and disk through the fake host, seam `ARK_FAKE_CPU_PERCENT` (and `ARK_FAKE_LOAD`) read only by `ark chief state`.
- The busy limit is the constant 90 percent.

## Steps

1. `ARK_FAKE_CPU_PERCENT=95`, `ARK_FAKE_LOAD=2`. Run the real `ark chief state`.
2. `ARK_FAKE_CPU_PERCENT=90.1`, same load.
3. `ARK_FAKE_CPU_PERCENT=95` and `ARK_FAKE_LOAD=500`.
4. No seam variables: run `ark chief state` on the real host (smoke of the real ~1 s sample).

## Expected results

- Step 1: the last line of the Host section is `hold new runs: CPU 95.0% is above the 90% busy limit`. It is the only `hold new runs:` line.
- Step 2: the line names 90.1% (just over the limit holds).
- Step 3: the same CPU reason, with no load reason; the load value is shown only on its `load (5 min)` line.
- Step 4: the Host section prints a CPU value that is not `unavailable`, the command exits 0, and the hold line is either `no` or a CPU/memory/swap/disk reason. The real sample is never null on the `chief state` path.

## Screenshot checkpoints

None. The surface is CLI output; no screenshot applies.
