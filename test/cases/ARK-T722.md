---
id: ARK-T722
title: ARK-T722 a quick ark test ticket does not pass a full ticket that has waited 10 minutes or more, passes one that has waited under 10 minutes, and a later full ticket never passes a blocked one
level: integration
technique: boundary value analysis on the waited time (9 minutes, 10 minutes back plus the time to start, 11 minutes through real `ark test` runs; exactly 600 000 ms and 599 999 ms under a frozen clock) with a real-clock bound and an injected clock that runs ahead
priority: high
risk: the bound never applies so a full run is starved by a stream of quick runs, the bound reads the injected test clock (`now` moves 31 s on each read in ARK-T155) instead of the real arrival time, so a run with that clock blocks or passes by the wrong time, or the bound is written into another process's ticket
status: active
changed_by: 2026-11-20-ARK-551-1
---

## Objective

Prove a waiting full ticket whose `arrival` is 10 minutes back or more is never passed by a quick ticket, and one that is under 10 minutes is. Serves ARK-551/AC2.

Expected: When the first waiting ticket is a `full` ticket that arrived 10 minutes before or more, no ticket shall pass it; when it arrived under 10 minutes before, a quick ticket that fits shall start.

## Preconditions

- The setup of ARK-T721 (budget 6, a started ticket of 4 cores, a waiting full ticket of 3 cores, a quick ticket of 2 cores that fits, host hold off). The full ticket is a hand-written file owned by a spawned `sleep`, so only its owner could mark it started: it never starts in this case.
- The `arrival` of the full ticket is written from one `Date.now()` read of the real clock: `Date.now() - minutes * 60_000`. In the frozen-clock rows (step 5) that read is `setSystemTime` of `bun:test`, and the budget gets a `now` option that starts 120 s ahead of it and moves 31 s on each read (as ARK-T155 does). A bound that reads that `now` sees the 599 999 ms ticket as 12 minutes old or more and blocks; a bound on the real arrival time does not.
- The text of the full ticket file before and after.

## Steps

1. Set the full ticket `arrival` 11 minutes back. Run the quick ticket and poll. Read the printed waiting line.
2. Set it 9 minutes back. Run the quick ticket and poll.
3. Set it 10 minutes back (one `Date.now()` read, so the admission sees 10 minutes plus the time to start). Run the quick ticket and poll. This is the real-process row of the edge; the exact millisecond is Step 5.
4. For 11 and 9 minutes, add a later full `ark test` of 2 cores (fits the free cores) and poll.
5. Frozen clock, in-process, no `ark test`: `setSystemTime(frozen)`, a `quick` budget from `openTestBudget` with the moving `now` option that starts 120 s ahead, the hold off by `ARK_FAKE_CPU_PERCENT=0`, and the full ticket's `arrival` set to `frozen - 600_000` ms (row 1) and `frozen - 599_999` ms (row 2). Call `take(2)` for the quick ticket and poll.
6. Compare the text of the full ticket file.

## Expected results

- Step 1: the quick ticket does not start; it prints the waiting line of its place and the holders, in the form of ARK-T156, and waits behind the full ticket.
- Step 2: the quick ticket starts at once; the full ticket still waits.
- Step 3: the quick ticket does not start (a ticket that waited 10 minutes plus the time to start is never passed).
- Step 4: the later full ticket does not start in either case.
- Step 5: row 1 (exactly 600 000 ms): the quick ticket prints its waiting line, has no `started`, the started cores stay at 4, and it is closed with the budget. Row 2 (599 999 ms): `take(2)` resolves with 2 cores at once and the started cores read 6. Both rows hold with the `now` option 120 s ahead, so the bound reads the real `arrival`, not that clock.
- Step 6: the full ticket file is unchanged by the quick process in every row (a process writes only its own ticket; the full ticket here never starts).

## Screenshot checkpoints

None. The surface is ticket files and CLI output; no screenshot applies.
