---
id: ARK-T156
title: ARK-T156 a waiting ark test prints its place and holders when they change, at most one line in 30 s by the injected clock
level: integration
technique: state transition with boundary values on the 30 s window
priority: high
risk: The wait line is spammed on every poll, is dropped after a quiet window, shows a stale place, or prints only the first holder as at the base
status: active
changed_by: 2026-11-09-ARK-390-1
---

## Objective

Prove the waiting line follows `readTestLock` data and the 30 s throttle, with a fake clock and a captured print sink, per `mockups/waiting-output.md`.

Expected: One line when the wait starts, then one line per change of place or holders, never more than one in 30 s.

## Preconditions

- The real wait loop of `ark test` with an injected clock and print sink; a real ticket store with two holders (3 cores each, held 12 and 4 minutes) and three waiters, the run under test third.
- No real sleep: the case moves the fake clock and the ticket store, then reads the sink.

## Steps

Budget 6. Order of arrival: A (3 cores) and B (3 cores) hold; W1 (3 cores), W2 (3 cores) and the run under test R (3 cores) wait, in that order. A held 12 min, B 4 min.

1. At 0 s R starts waiting; read the sink.
2. At 10 s W1 is cancelled (its process is killed; its ticket is dropped by the store). R moves from place 3 to 2. At 20 s change nothing.
3. At 30 s advance the clock.
4. At 45 s only the held minutes advance by one.
5. At 50 s A ends; W2 (3 cores) is admitted and becomes a holder (`<1 min`); R moves to place 1. At 60 s advance.
6. At 90 s B ends; R (3 cores) is admitted next to W2; read the sink.

## Expected results

- Line at 0 s: `waiting: place 3 of 3; running: <A> 3 cores 12 min, <B> 3 cores 4 min`.
- Nothing at 10 s and 20 s; at 30 s one line with place 2 of 2 and holders A and B (latest state).
- Nothing at 45 s (minutes alone are not a change).
- Nothing at 50 s; at 60 s one line with place 1 of 1 and holders B `4 min` (plus elapsed) and W2 `<1 min`.
- At 90 s no wait line; exactly three lines in total, no two within 30 s.
- With no holder the line reads `running: none`; a request above the budget shows the clamped cores.

## Screenshot checkpoints

None. The surface is CLI output; the line text is asserted directly.
