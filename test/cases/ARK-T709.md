---
id: ARK-T709
title: "ARK-T709 ark test starts a waiting suite when no suite is running, whatever the CPU use or the load, and still waits for memory; while another suite runs it holds on CPU and starts when that suite ends"
level: integration
technique: "state transition (held by CPU with a suite running, then idle, then started) and equivalence classes (nothing running vs one suite running; CPU hold vs memory hold)"
priority: high
risk: "The CPU hold has no idle exception, so a host whose CPU reads above the limit, or whose CPU use cannot fall because the only reader of it is a suite that waits, keeps every `ark test` waiting for ever (ARK-586: tests running 0, waiting 3); or the exception reaches the memory hold, so a suite starts into a swapping host when nothing runs; or a suite counts its own waiting ticket as a running suite, so the exception never applies; or a suite that ended (a stale ticket of a dead pid) still counts as running, so the hold never opens"
status: active
changed_by: 2026-11-20-ARK-586-1
---

## Objective

Prove `ark test` takes the CPU hold only while another suite runs on the host. With nothing running, a waiting suite starts at CPU use above the limit and a load average far above the core count. With a suite running, the same reading holds it, and it starts once the running suite ends, with the CPU reading unchanged. A memory hold is not lifted by an idle host.

Gate answers:

1. Protects the admission contract of AC1: the hold can delay a suite, never stop all of them.
2. A regression that fails it: the CPU hold has no idle exception, or the exception is also taken for memory, or the waiting suite counts itself or a dead ticket as running.
3. No case holds this. ARK-T710 owns the CPU rule (what the hold reads and its limit) and runs every row with a suite running, so it never reaches the idle path. ARK-T187 owns the memory hold with nothing running and does not set the CPU. ARK-T694 owns the hold's recovery and print cadence in process. ARK-T695 owns the bare path.
4. No new hook. The case sets `ARK_FAKE_CPU_PERCENT` and `ARK_FAKE_LOAD_ONE` in the environment of `ark test`: the seams are read by the production reader of `cli/host.ts` that the detached runner calls (ARK-T365 owns the `chief state` use of the same CPU seam). The holder is the real `openTestBudget` in a real child process (the holder of ARK-T683), and the case runs the real `ark test`.

## Preconditions

- Temp project and temp `ARK_HOME`, one run with one cheap suite whose command writes a marker file; the CPU budget has free cores beyond the holder's, so only the hold can wait. Memory and swap are healthy (the fake host of ARK-T187).
- Fresh state per scenario. Each scenario below (step 1, steps 2 and 3 together, step 4, step 5) starts from its own temp project, temp `ARK_HOME` (so its own ticket store and result cache) and marker directory, with no marker and no earlier successful result: an earlier scenario cannot supply a marker, and ARK-T163's reuse of an unchanged successful suite cannot skip admission. Only steps 2 and 3 share one waiting `ark test` invocation (the transition from held to started).
- `ARK_FAKE_CPU_PERCENT=99` and `ARK_FAKE_LOAD_ONE=500` in the environment of the `ark test` child, so the CPU is over the limit (90) and the load is over the core count of any host.
- Holder: a real child process: `openTestBudget("holder", <budget>, ...)` and `await budget.take(1)` from `cli/test-lock.ts`, then it blocks reading its standard input until the case writes to it (the release) or ends. Its ticket pid is live and its ticket is `started`.
- The case runs `ark test` as a real process, in the background for a hold. It waits on events (a printed line, the marker, the ticket file, the process exit) and, where the run must stay held, over three poll intervals. It stops a run that stays held with `ark test <run> --stop`, as ARK-T235 does.

## Steps

1. Fresh state. Nothing running: no holder, empty ticket store. Run `ark test <run>` to its end.
2. Fresh state. Holder running (1 core of the budget). Run `ark test <run>` in the background; wait for its waiting line; wait over three poll intervals; read the marker and the ticket store.
3. Same invocation as step 2, same state. Release the holder (it ends; its ticket goes). Leave the CPU and load readings unchanged. Wait for the run to end.
4. Fresh state. Dead holder: start the holder, kill it by its PID without letting it release its ticket (a stale `started` ticket of a dead pid stays in the store), then run `ark test <run>` to its end.
5. Fresh state. Memory still holds when nothing runs: no holder; fake memory at 15 percent free (under the floor 20); CPU 99. Run `ark test <run>` in the background; wait over three poll intervals; read the output and the marker; rewrite the fake host to healthy and wait for the end.

## Expected results

- Step 1: the suite starts at once, exit 0, marker written, no `waiting for` line in the output.
- Step 2: the marker is absent; the output has one `ark test: waiting for CPU` line that names the CPU reading and the limit 90, however many polls pass; the run's ticket is waiting with no `started` mark; the holder's ticket is untouched.
- Step 3: the waiting run starts after the holder's ticket is gone, exit 0, marker written, with no further waiting line: the CPU is still 99 and the load still 500, so only "no suite is running" lifted the hold.
- Step 4: the suite starts at once, exit 0, marker written (a ticket of an ended process is not a running suite).
- Step 5: the marker is absent while the run waits and the output has exactly one `waiting for memory` line (no CPU line, since CPU 99 with nothing running does not hold and does not mask memory); after the rewrite the suite starts and the run exits 0.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
