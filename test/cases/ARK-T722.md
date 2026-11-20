---
id: ARK-T722
title: ARK-T722 a quick ark test ticket does not pass a full ticket that has waited 10 minutes or more, passes one that has waited under 10 minutes, and a later full ticket never passes a blocked one
level: integration
technique: boundary value analysis on the waited time (9 minutes, exactly 10 minutes, 11 minutes) with a clock that does not move the bound
priority: high
risk: the bound never applies so a full run is starved by a stream of quick runs, the bound reads the injected test clock (`now` moves 31 s on each read in ARK-T155) and trips at once or never, the bound is off by one at exactly 10 minutes, or the bound is written into another process's ticket
status: active
changed_by: 2026-11-20-ARK-551-1
---

## Objective

Prove a waiting full ticket whose `arrival` is 10 minutes back or more is never passed by a quick ticket, and one that is under 10 minutes is. Serves ARK-551/AC2.

Expected: When the first waiting ticket is a `full` ticket that arrived 10 minutes before or more, no ticket shall pass it; when it arrived under 10 minutes before, a quick ticket that fits shall start.

## Preconditions

- The setup of ARK-T721 (budget 6, a started ticket of 4 cores, a waiting full ticket of 3 cores, a quick ticket of 2 cores that fits, host hold off).
- The `arrival` of the full ticket is written from one `Date.now()` read of the real clock: `Date.now() - minutes * 60_000`. The fixture passes a `now` option that moves 31 s on each read (as ARK-T155 does) in one run, to prove the bound does not read it.
- Hash of the full ticket file before and after.

## Steps

1. Set the full ticket `arrival` 11 minutes back. Run the quick ticket and poll. Read the printed waiting line.
2. Set it 9 minutes back. Run the quick ticket and poll.
3. Set it exactly 10 minutes back (one `Date.now()` read). Run the quick ticket and poll.
4. For 11 and 9 minutes, add a later full ticket of 2 cores (fits the free cores) and poll.
5. For 11 minutes, end the holder. Poll the full and the quick ticket.
6. Run Step 2 once more with the moving `now` option.
7. Compare the hash of the full ticket file.

## Expected results

- Step 1: the quick ticket does not start; it prints the waiting line of its place and the holders, in the form of ARK-T156, and waits behind the full ticket.
- Step 2: the quick ticket starts at once; the full ticket still waits.
- Step 3: the quick ticket does not start (10 minutes or more is never passed).
- Step 4: the later full ticket does not start in either case.
- Step 5: the full ticket starts first (the holder's cores are free for it); the quick ticket starts only when the budget has room for both.
- Step 6: the quick ticket starts the same as in Step 2; the moving `now` has no effect on the bound.
- Step 7: the full ticket file is unchanged by the quick process (a process writes only its own ticket), except for its own `started` write.

## Screenshot checkpoints

None. The surface is ticket files and CLI output; no screenshot applies.
