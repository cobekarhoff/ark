---
id: ARK-T61
title: ARK-T61 ark chief state lists the run that holds the ark test lock and the run that waits, with waited time
level: integration
technique: state transition (no ticket, one running, one running and one waiting), error guessing (ended-pid tickets)
priority: medium
risk: the running and the waiting suites stay invisible, so the human cannot tell why `ark test` does not start; or a ticket of an ended pid shows as a ghost; or the new section breaks the other sections of `ark chief state`
status: active
changed_by: 2026-11-09-ARK-390-1
---

## Objective

Prove that `ark chief state` lists the running and the waiting suites of the ark test budget with cores and time. Serves ARK-390/AC1.

Expected: While one run holds cores and another waits, the system shall list the running run with its cores and running time and the waiting run with its cores and waited time in `ark chief state`; the system shall not list a ticket whose process has ended.

## Preconditions

- A temporary `ARK_HOME` with a fixture project and two fixture runs, A and B, as in `test/chief.test.ts`, and a budget of 6 cores.
- The suite of A holds until a `release` file appears, so A runs while the test reads the state.

## Steps

1. Run `ark chief state` with no ticket. Note the output.
2. Start `ark test A`, wait until its suite has started. Start `ark test B`, wait until its stdout holds `waiting:`.
3. Run `ark chief state` and read the `ark test budget` section.
4. Add a running ticket and a waiting ticket of a dead pid to the `test-budget` folder, and run `ark chief state` again.
5. Create the `release` file, wait for both processes to exit, and run `ark chief state`.

## Expected results

- Step 1: no `ark test budget` section, and the `Open runs` section as before.
- Step 3: the section holds `running: <A> (pid <pid of A>), 6 cores, running <n>s|m` and `waiting: <B> (pid <pid of B>), 6 cores, waited <n>s|m`.
- Step 4: the runs of the dead pid are not listed.
- Step 5: no `ark test budget` section.

## Screenshot checkpoints

None, CLI output.
