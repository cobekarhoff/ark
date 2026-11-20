---
id: ARK-T707
title: ARK-T707 a whole-suite bun test skips the budget wait only while the run named by its ark test marker is alive and holds a started ticket; a hand-set marker waits like a bare run
level: integration
technique: decision table on the marker (absent, hand-set, dead pid, live pid with no started ticket, live holder, holder after release) and state transition (holder alive, then released)
priority: high
risk: a person or a script sets `ARK_TEST_BUDGET=held` by hand (or inherits it from a run that ended) and starts a whole-suite `bun test` that takes no cores while `ark test` runs hold the budget (host load 77 to 107, a different timeout in every ARK-527 Playwright run); or a marker that names a live pid with no ticket skips the wait; or the new check rejects the marker value a real held run writes, so a run that carries it waits on its own holder; or a whole-suite run started from a single-file run starts at once on cores that run never held
status: active
changed_by: 2026-11-19-ARK-569-1
---

## Objective

The wait of ARK-T683 is skipped only when the marker names a live run that holds a started ticket in the store. A marker with any other value waits like a bare run; the marker value a real held bare run writes still starts a whole-suite run at once. The lifecycle of the `ark test` children (head suite, base run, census) and of a held bare run's nested suite is owned by ARK-T684 steps 3 to 5, and this case does not repeat it.

Decision for the file run (`bun test test/a.test.ts`, which holds no cores): it writes no marker, so a whole-suite `bun test` that one of its tests starts waits like a bare run. This replaces the "nested runs never wait" of ARK-T684 step 5 for file runs.

## Preconditions

- The fixture of ARK-T683 and ARK-T684: temp `ARK_HOME`, project `demo` with `test_budget_cores: 3`, scratch repo with the preload and marker-writing test files, `ARK_FAKE_HOST`, `ARK_FAKE_LOAD_ONE=0`. The environment of each `bun test` the case starts is built, never inherited.
- The format of the marker value is not copied from the source: a probe test file writes `process.env.ARK_TEST_BUDGET` into a file, and the case reads it back from a real held run (step 1).
- Holder: a real child that holds 3 of 3 cores until the case writes to its standard input.
- The case starts every process itself and stops it by pid.

## Steps

1. Start a bare `bun test --parallel=3` (holds 3 of 3, its probe file runs inside). Read the marker value M it wrote and the pid it names. This run is the live holder H.
2. While H holds: start `bun test test --parallel=3` with the environment marker set to M. It starts at once, takes no ticket, prints no waiting line.
3. Same state, one run per marker value, each waits (a `bun test` waiting ticket in the store, no file ran, one waiting line at most): `held` set by hand, `1`, no marker at all (control), M with the pid replaced by a dead pid (the case started a process and reaped it), M with the pid replaced by a live pid that holds no ticket (the case's own `sleep`).
4. Release H and wait until it has exited. Start `bun test test --parallel=3` with the marker M of step 1: (no holder now) it takes its cores through its own ticket at once, and the store shows that ticket. Then start the same command with a new holder holding 3 of 3 and marker M still naming the ended H: it waits.
5. A single-file run `bun test test/spawn.test.ts` while a holder holds 3 of 3, whose test starts a whole-suite `bun test --parallel=2`: the nested run waits (it holds one waiting ticket) until the holder releases.

## Expected results

- Step 1: M names H's pid, and the store holds H's started ticket.
- Step 2: the run starts at once; the store gains no ticket; no waiting line.
- Step 3: every row holds one waiting ticket labelled `bun test`, runs no file before the release, prints at most one waiting line; the no-marker control is identical.
- Step 4: first row: starts and takes a ticket of its own; second row: waits, store shows its waiting ticket.
- Step 5: the nested run waits and starts only after the release; the case ends without deadlock.
- At the base commit steps 3 (hand-set `held`) and 4 (second row) start at once, so the case fails there.
- The head suite, base run, census run and held-bare nested run still starting at once under the new rule are proved by ARK-T684 steps 3 to 5; this case does not repeat them.

## Screenshot checkpoints

none: CLI output and files, no UI.
