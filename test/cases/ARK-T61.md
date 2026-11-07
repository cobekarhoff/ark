---
id: ARK-T61
title: ARK-T61 ark chief state lists the run that holds the ark test lock and the run that waits, with waited time
level: integration
technique: state transition (no lock, holder only, holder and waiter), error guessing (dead waiter entry)
priority: medium
risk: the lock holder and the queue stay invisible, so the human cannot tell why `ark test` does not start; or a dead waiter's entry shows as a ghost; or the new section breaks the other sections of `ark chief state`
status: active
changed_by: 2026-11-06-ARK-343-1
---

## Objective

Prove that `ark chief state` shows the holder and each live waiter of the ark test lock with the time each has waited. Serves ARK-343/AC3.

Expected: While one run holds the ark test lock and another waits, the system shall list the holder and the waiter in `ark chief state`, each with its waited time; the system shall not list a waiter whose process has ended.

## Preconditions

- A temporary `ARK_HOME` with a fixture project and two fixture runs, A and B, as in `test/chief.test.ts`.
- Suite of A sleeps until a file appears, so A holds the lock while the test reads the state.

## Steps

1. Run `ark chief state` with no lock. Note the output.
2. Start `ark test A`, wait until its suite has started. Start `ark test B`, wait until its stdout holds `waiting for ark test of A`.
3. Run `ark chief state` and read the ark test lock section.
4. Add a waiter entry of a dead pid to the waiter folder in the format `ark test` writes, and run `ark chief state` again.
5. Create the release file, wait for both processes to exit, and run `ark chief state`.

## Expected results

- Step 1: no ark test lock section, and the other sections as before.
- Step 3: the section names A with its pid as holder and B with its pid as waiting, and each has a waited time in minutes or seconds.
- Step 4: the dead pid's run is not listed.
- Step 5: no ark test lock section.

## Screenshot checkpoints

None, CLI output.
