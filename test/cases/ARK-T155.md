---
id: ARK-T155
title: ARK-T155 ark test admits a suite in arrival order when its cores fit the budget, clamps a request above it, and frees an ended pid
level: integration
technique: state transition (waiting, running, ended) with boundary values on cores against the budget
priority: high
risk: A later small suite overtakes an older large one, a request above the budget waits forever, an ended pid keeps its cores, or the budget default or placeholder is wrong
status: active
changed_by: 2026-11-09-ARK-390-1
---

## Objective

Prove the budget ticket store admits per suite, first-in-first-out, from `test_budget_cores`, with the cores passed to the suite command by the `<cores>` placeholder.

Expected: A request that fits starts at once; one that does not waits; it starts when cores free up; nobody overtakes; no ticket of an ended pid holds cores.

## Preconditions

- Temp `ARK_HOME` with `ark.yml` that sets `test_budget_cores: 6` and a suite whose command writes its argument line to a file (`cmd --n=<cores>`); the real ticket store and the real `ark test` / `readTestLock` code paths.
- Live holder processes are real child processes that block on a file the case removes; no sleep: the case awaits admission by an event or a file.

## Steps

1. With budget 6, start a cli suite (3 cores) from run A and a cli suite (3 cores) from run B: both start at once, and each command line has `--n=3`. The two overlap in time (concurrent capacity).
2. Queue a 6-core request W1 (older) and then a 1-core request W2 (newer) while A and B hold 6 cores: both wait.
3. End A's suite (run A's `ark test` still alive, next suite not yet started): 3 cores are free. W2 (1 core) fits, but W1 is older and needs 6: neither starts.
4. End B's suite: W1 starts alone (`--n=6`). End W1's suite: W2 starts (`--n=1`). Release is per suite, not at the end of the run's whole `ark test`.
5. Request with no cores in the suite: it takes the whole budget and runs alone (the ARK-343 one-at-a-time behaviour). Request above the budget (8 cores, budget 6): it clamps to 6 and starts when idle (`--n=6`).
6. With no `test_budget_cores` in `ark.yml` on a host the case fixes at 10 cores: the budget is 6.

Not repeated here: chief-state holder/waiter data (ARK-T61), dead-holder recovery (ARK-T60), SIGINT cleanup and whole-budget mutual exclusion (ARK-T59), older-waiter precedence of equal-size requests (ARK-T113). They are updated for budget tickets and linked to AC3.

## Expected results

- Step 1: both start at once with `--n=3`; running cores = 6.
- Step 3: nothing starts; running cores = 3 (head-of-line blocking, the 1-core request does not overtake).
- Step 4: W1 starts first, alone, with `--n=6`; then W2 with `--n=1`; running cores <= budget at every observed state.
- Step 5: whole-budget request has cores equal to the budget and runs alone; the 8-core request shows 6 and starts.
- Step 6: budget 6.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
