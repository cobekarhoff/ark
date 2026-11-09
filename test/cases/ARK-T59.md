---
id: ARK-T59
title: ARK-T59 two ark test processes of two runs never run their suites at the same time
level: integration
technique: state transition (free, held, released), plus signal and failure exits
priority: high
risk: two `ark test` runs on one host run their suites together, so the load average rises and timing-sensitive tests fail at random; or the budget tickets stay after a failed suite, SIGINT or SIGTERM and hold cores until the stale-pid check clears them; or a signal frees the cores while the suite still runs
status: active
changed_by: 2026-11-09-ARK-390-1
---

## Objective

Prove that two `ark test` processes whose suites each ask for the whole budget run them one at a time, print their place while they wait, and remove every ticket on every exit. Serves ARK-390/AC1.

Expected: When two suites each take the whole budget, the system shall run them one at a time; the waiting `ark test` shall print `waiting: place <n> of <m>; running: <run> <cores> cores`; the system shall remove the tickets of `ark test` when it ends by pass, suite failure, SIGINT or SIGTERM, and shall keep the cores until the suite of a signalled `ark test` has ended.

## Preconditions

- A temporary `ARK_HOME` with two fixture projects, run A in project 1 and run B in project 2, a budget of 6 cores, and suites whose command appends `start <run>` to a shared log and `end <run>` after a short sleep. A variant exits 1; a variant holds until a `release` file appears and, after a signal, needs two seconds to end.

## Steps

1. Start `ark test A`. Wait until the log holds `start A`. Start `ark test B` and collect its stdout. Wait for both to exit.
2. Read the log, the stdout of B and the `test-budget` folder.
3. Failing suite: run `ark test A` with the failing script to the end. Straight after A exits, check the `test-budget` folder. Then run `ark test B` and collect its stdout.
4. Signals, for SIGINT and again for SIGTERM: start `ark test A`, wait for `start A`, send the signal to its pid, wait for exit. Straight after, check the `test-budget` folder, then run `ark test B`.
5. Slow end: with the holding and slow-ending suite, start A, then B until B prints `waiting:`. Signal A and wait for it to exit. Create the `release` file and wait for B.

## Expected results

- Step 2: each `start` is followed at once by the `end` of the same run, and both runs ran. B's stdout holds `waiting: place 1 of 1; running: A 6 cores`. No ticket remains.
- Step 3 and 4: no ticket exists right after A exits, and B starts with no `waiting` line and no `took over a stale` line, which proves A removed its tickets itself.
- Step 5: `end A` comes before `start B` in the log.

## Screenshot checkpoints

None, CLI output.
