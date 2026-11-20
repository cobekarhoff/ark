---
id: ARK-T721
title: ARK-T721 a quick ark test ticket that fits the free cores starts ahead of a blocked full ticket, passes the same host hold, never takes the started cores above the budget, and a ticket without mode counts as full
level: integration
technique: boundary values on cores (2 fits, 3 does not, with 4 of 6 held), decision table (mode quick or full, fits or not, host hold on or off), race made real with two processes
priority: high
risk: the overtake lets a quick ticket start that does not fit (budget exceeded, two suites overload the host), skips the host hold of memory and CPU so ARK-515 and ARK-586 are bypassed, lets a quick ticket pass a waiting ticket that has no mode (an older runner) or is a full ticket of the same size, prunes a ticket without a mode as unreadable, or lets a quick ticket that arrived later revoke the earlier full ticket in a race
status: active
changed_by: 2026-11-20-ARK-551-1
---

## Objective

Prove the admission in `cli/test-lock.ts` lets a quick ticket pass the first waiting ticket of a full run only when it fits the free cores and the host hold lets it, and that the started cores never pass the budget. Serves ARK-551/AC1.

Expected: When the first waiting ticket is a `full` ticket that does not fit now, a later `quick` ticket whose cores fit the free cores shall mark itself started at once, and the full ticket shall keep waiting.

## Preconditions

- A fixture `ARK_HOME` with a `test-budget` folder and a budget of 6 cores.
- `ARK_FAKE_CPU_PERCENT` set low, `minimumFreeMemoryPercent: 0` and a swap limit as `test/load-hold.test.ts` sets them, so the 1 s CPU sample of the hold never decides the result.
- Ticket pids that are alive: a started ticket of 4 cores held by a spawned `sleep` (stopped by its PID at the end), and a waiting ticket of a full run that asks 3 cores and arrived first (its pid is a second `sleep`, ticket `mode: full`).
- A reader of every ticket file sampled at each poll (the started cores sum).

## Steps

1. With the 4 cores held and the full ticket (3 cores) waiting, run `ark test <run> --quick` with a quick ticket of 2 cores through the real `openTestBudget` path (`executeTest` passes the mode). Poll the ticket folder.
2. Read the quick ticket: `started` set. Read the full ticket: still waiting. Sum the started cores at every poll.
3. Repeat with a quick ticket that asks 3 cores while the 4 cores are held. Poll for a window longer than one hold sample.
4. Repeat Step 1 with the host hold set to wait (CPU above the limit through `ARK_FAKE_CPU_PERCENT`). Then lower it.
5. Repeat Step 1 with a waiting ticket that holds no `mode` field (written by an older runner), and with a waiting full ticket and a later full ticket of 2 cores (a `full` runner, not `--quick`).
6. Race: two real `ark test` processes, a quick one of 2 cores and the full one of 4 cores, with the holder of 4 cores ending between the quick ticket's read and its `started` write. Both overflow 6 when the quick one is already started. Repeat the one test file with `bun test --rerun-each=20 <file>`.
7. Read the printed waiting line of the quick and the full runner and the `## ark test budget` rows of `ark chief state`.

## Expected results

- Step 2: the quick ticket has `started` at once (before the hold's next sample), the full ticket has none. The started cores never sum above 6 at any poll.
- Step 3: the 3-core quick ticket does not start while the 4 cores are held and starts only after the holder ends.
- Step 4: while the host hold waits, the overtaking quick ticket does not mark itself started and prints the hold reason, as a first ticket does; it starts after the hold clears.
- Step 5: a waiting ticket without `mode` reads as `full`: the quick ticket still passes it when it fits, and the ticket is not pruned as unreadable. A later `full` ticket never passes the blocked full ticket, even when it fits (ARK-T113 stays true).
- Step 6: the earlier full ticket keeps `started` and the later quick ticket revokes (removes its `started`), in every repeat; the started cores never exceed 6 after the revoke check.
- Step 7: the waiting line keeps its form (the place and the holders; no `mode` in it), and `ark chief state` lists the waiting and the started tickets as before.

## Screenshot checkpoints

None. The surface is ticket files and CLI output; no screenshot applies.
