---
id: ARK-T289
title: ARK-T289 each host signal gets its AC2 level at and around each threshold, and an unreadable signal is unchecked, never normal
level: integration
technique: boundary values on each threshold (below, at, above), equivalence classes for pressure level, null (unread) handling
priority: high
risk: a threshold is off by one (load 10 shown as amber, 12 as amber, disk 30 GB as red), the macOS pressure codes 1/2/4 are mapped wrong, or a reader that fails shows normal (green) so the human trusts a host whose memory is not read
status: active
changed_by: 2026-11-12-ARK-418-1
---

## Objective

`readHost` (`cli/host.ts`), the one host-memory function of ARK-417, returns CPU %, load 1/5/15 with the core count, swap used, free GB on `/` and the memory pressure level. A level function gives each signal normal, amber, red or `unchecked` as AC2 decides. A signal that cannot be read is `unchecked`.

## Preconditions

- Fake readers injected into `readHost` for: `sysctl kern.memorystatus_vm_pressure_level`, `memory_pressure`, `vm.swapusage`, load average, core count, CPU %, and `statfs` of `/`. No real host value is used.
- Thresholds: pressure 1 normal, 2 amber (warn), 4 red (critical); load over 10 amber, over 12 red; free disk under 30 GB amber, under 15 GB red; swap over 2 GB amber, over 6 GB red. CPU % and core count have no level; they are shown.
- The hub runs with the same fake readers (served through the `resources` source) for the strip assertion in step 4.

## Steps

1. Table-drive the level function over these values and record the level of each:
   - pressure: 1, 2, 4.
   - load 5-minute (and 1, 15): 9.99, 10, 10.01, 12, 12.01.
   - disk free GB: 30.01, 30, 29.99, 15, 14.99.
   - swap used GB: 2, 2.01, 6, 6.01.
2. For each of pressure, load, disk, swap, and CPU %, make the fake reader fail (throw, non-zero exit, unparseable output) one at a time, and read the whole `HostReading` and its levels.
3. Make all readers fail at once.
4. Serve the reading through the hub and `GET /api/snapshot`; read the host part.

## Expected results

- Pressure: 1 normal, 2 amber, 4 red.
- Load: 9.99 and 10 normal (over 10 is strict), 10.01 and 12 amber, 12.01 red. Disk: 30.01 and 30 normal (under 30 is strict), 29.99 amber, 15 amber, 14.99 red. Swap: 2 normal, 2.01 amber, 6 amber, 6.01 red.
- The failed signal of step 2 reads `unchecked` in the reading and the level; the other signals keep their levels. `unchecked` is a value different from normal and the snapshot carries it explicitly (no null shown as green).
- Step 3: every signal `unchecked`; no throw.
- Step 4: the snapshot host part holds the same value and level of each signal as step 1, plus the core count next to load.
- Admission and `ark chief state` behaviour with an unreadable reading (fail-open: `memory: unchecked`, no hold) is owned by ARK-T187 and ARK-T188, reused here and not repeated; this case adds no hold or admission oracle.

## Screenshot checkpoints

none: no UI surface in this case; the colour of each level is the Playwright case ARK-T290.
