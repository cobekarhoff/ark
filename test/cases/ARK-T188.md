---
id: ARK-T188
title: ARK-T188 ark chief state prints a Host section and a 'hold new runs' line for each reason, or 'hold new runs: no'
level: integration
technique: equivalence classes (no limit crossed, one class for each of free memory, swap, load, disk) and boundary values at each limit
priority: high
risk: Master Chief starts runs on a host that is swapping, loaded or out of disk because the hold line is missing, names the wrong reason, or holds a healthy host; or the Host section disappears when no test runs
status: active
changed_by: 2026-11-09-ARK-417-1
---

## Objective

Prove `ark chief state` prints the Host readings and one `hold new runs:` line that is `no` on a healthy host and names each crossed limit otherwise.

## Preconditions

- Temp project and temp `ARK_HOME` with no test lock tickets, and no live Orca (the sections for Orca print their unavailable lines).
- Fake host reading at the real boundary as in ARK-T187 (fake `memory_pressure`, `sysctl vm.swapusage`, 5-minute load and disk readings that the real reader parses). The limits the plan sets for load (over the core count) and disk (under the fixed free GB it names) are the values the steps use; the free memory floor and swap ceiling are the `ark.yml` values, default 20 percent and 8 GB.

## Steps

1. Healthy host: 50 percent free, 2 GB swap, load below the core count, disk above the limit. Run the real `ark chief state`.
2. Free memory 19 percent, the rest healthy.
3. Swap 8.1 GB, the rest healthy.
4. Load just over the core count, the rest healthy.
5. Free disk just under the disk limit, the rest healthy.
6. Each limit exactly at its value, the rest healthy.
7. Free memory, swap, load and disk all crossed.
8. Two lock tickets in the temp lock folder (one started, one waiting), healthy host.
9. A reading that fails (swap unreadable), the rest healthy.

## Expected results

- Step 1: a `## Host` section with free memory in percent, swap used, the 5-minute load, free disk and `tests: running 0, waiting 0` (the section prints when no test is queued), and the line `hold new runs: no`.
- Step 2: `hold new runs: free 19% is below the 20% floor`.
- Step 3: the line names swap and its numbers, for example `hold new runs: swap 8.1 GB is above the 8 GB ceiling`.
- Step 4: the line names the load and the limit; Step 5: the line names the disk and the limit.
- Step 6: `hold new runs: no` (a limit is crossed only beyond its value, as in ARK-T187).
- Step 7: one `hold new runs:` line with the four reasons joined in the fixed order free memory, swap, load, disk. There is exactly one such line.
- Step 8: the Host section says `running 1, waiting 1`, and the `## ark test budget` section still lists both.
- Step 9: the other readings print, the unreadable one prints `swap used: unavailable`, and it never causes a hold.

## Screenshot checkpoints

None. The surface is CLI output; no screenshot applies.
