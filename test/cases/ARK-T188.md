---
id: ARK-T188
title: "ARK-T188 ark chief state prints a Host section and a 'hold new runs' line for each reason, or 'hold new runs: no'"
level: integration
technique: "equivalence classes (no limit crossed, one class for each of free memory, swap, disk, all crossed) and boundary values at the memory, swap and disk limits"
priority: high
risk: "Master Chief starts runs on a host that is swapping or out of disk because the hold line is missing, names the wrong reason or the wrong order, or holds a healthy host; or the Host section disappears when no test runs"
status: active
changed_by: 2026-11-13-ARK-434-1
---

## Objective

Prove `ark chief state` prints the Host readings and one `hold new runs:` line that is `no` on a healthy host and names each crossed memory, swap or disk limit otherwise, in the fixed order with CPU between swap and disk.

The CPU reason and its 90 / 90.1 percent boundary are owned by ARK-T365 and ARK-T366. This case uses CPU only as a healthy reading (step 1) and as one crossed reason in the order check (step 3). The memory and swap limits (each crossed only beyond its value) and the single-reason lines are owned by ARK-T187, which reads the same `memoryReasons`.

The `no free-memory reason above the floor` contract (a free-memory reason is never named while free memory is above the floor) is proved by step 1 (healthy host) and step 5 (unreadable reading), the tests that go red when `cli/host.ts` names it; the test of step 3 crosses both limits and cannot catch it.

## Preconditions

- Temp project and temp `ARK_HOME` with no test lock tickets, and no live Orca (the sections for Orca print their unavailable lines).
- Fake host reading at the real boundary as in ARK-T187 (fake `memory_pressure`, `sysctl vm.swapusage`, 5-minute load and disk readings that the real reader parses, and the CPU reading of the `chief state` seam `ARK_FAKE_CPU_PERCENT`, see ARK-T365). The disk limit (under the fixed free GB it names) is the value the steps use; the free memory floor and swap ceiling are the `ark.yml` values, default 20 percent and 8 GB.

## Steps

1. Healthy host: 50 percent free, 2 GB swap, CPU 10 percent, disk above the limit. Run the real `ark chief state`.
2. Free disk just under the disk limit, the rest healthy.
3. Free memory (19 percent), swap (8.1 GB) and CPU (95 percent) crossed together, disk healthy.
4. Two lock tickets in the temp lock folder (one started, one waiting), healthy host.
5. A reading that fails (swap unreadable), the rest healthy.

## Expected results

- Step 1: a `## Host` section with free memory in percent, swap used, the 5-minute load, the CPU use, free disk, `tests: running 0, waiting 0` (the section prints when no test is queued), the `orphaned bun test workers:` line owned by ARK-T706 (the real host's count, so `0`, `<n> (<MB> MB)` or `unavailable` all pass here), and the line `hold new runs: no`.
- Step 2: the line names the disk and the limit.
- Step 3: one `hold new runs:` line with the reasons joined in the fixed order free memory, swap, CPU. There is exactly one such line.
- Step 4: the Host section says `running 1, waiting 1`, and the `## ark test budget` section still lists both.
- Step 5: the other readings print, the unreadable one prints `swap used: unavailable`, and it never causes a hold.

## Screenshot checkpoints

None. The surface is CLI output; no screenshot applies.
