---
id: ARK-T722
title: ARK-T722 a quick ark test ticket does not pass a full ticket that has waited 10 minutes or more, passes one that has waited under 10 minutes, and a later full ticket never passes a blocked one
level: integration
technique: boundary value analysis on the waited time (9 minutes, 10 minutes back plus the time to start, 11 minutes) with a real-clock bound and an injected clock that runs ahead
priority: high
risk: the bound never applies so a full run is starved by a stream of quick runs, the bound reads the injected test clock (`now` moves 31 s on each read in ARK-T155) instead of the real arrival time, so a run with that clock blocks or passes by the wrong time, or the bound is written into another process's ticket
status: active
changed_by: 2026-11-20-ARK-551-1
---

## Objective

Prove a waiting full ticket whose `arrival` is 10 minutes back or more is never passed by a quick ticket, and one that is under 10 minutes is. Serves ARK-551/AC2.

Expected: When the first waiting ticket is a `full` ticket that arrived 10 minutes before or more, no ticket shall pass it; when it arrived under 10 minutes before, a quick ticket that fits shall start.

## Preconditions

- The setup of ARK-T721 (budget 6, a started ticket of 4 cores, a waiting full ticket of 3 cores, a quick ticket of 2 cores that fits, host hold off).
- The `arrival` of the full ticket is written from one `Date.now()` read of the real clock: `Date.now() - minutes * 60_000`. In one run the fixture passes a `now` option that starts 120 s ahead of the real clock (`time = Date.now() + 120_000`) and moves 31 s on each read (as ARK-T155 does). A bound that reads that `now` sees the 9-minute ticket as 11 minutes old or more and blocks; a bound on the real arrival time does not.
- Hash of the full ticket file before and after.

## Steps

1. Set the full ticket `arrival` 11 minutes back. Run the quick ticket and poll. Read the printed waiting line.
2. Set it 9 minutes back. Run the quick ticket and poll.
3. Set it 10 minutes back (one `Date.now()` read, so the admission always sees 10 minutes plus the time to start). Run the quick ticket and poll. This step proves the full ticket is never passed from 10 minutes on; it does not pin the exact millisecond of the edge.
4. For 11 and 9 minutes, add a later full ticket of 2 cores (fits the free cores) and poll.
5. For 11 minutes, end the holder. Poll the full and the quick ticket.
6. Run Step 2 once more with the moving `now` option (starting 120 s ahead).
7. Compare the hash of the full ticket file.

## Expected results

- Step 1: the quick ticket does not start; it prints the waiting line of its place and the holders, in the form of ARK-T156, and waits behind the full ticket.
- Step 2: the quick ticket starts at once; the full ticket still waits.
- Step 3: the quick ticket does not start (a ticket that waited 10 minutes plus the time to start is never passed).
- Step 4: the later full ticket does not start in either case.
- Step 5: the full ticket starts first (the holder's cores are free for it); the quick ticket starts only when the budget has room for both.
- Step 6: the quick ticket starts at once, the same as in Step 2: the 9-minute ticket stays under the bound by its real arrival time, although the moving `now` is over 10 minutes ahead of it.
- Step 7: the full ticket file is unchanged by the quick process (a process writes only its own ticket), except for its own `started` write.

## Screenshot checkpoints

None. The surface is ticket files and CLI output; no screenshot applies.
