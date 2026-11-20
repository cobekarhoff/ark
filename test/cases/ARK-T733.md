---
id: ARK-T733
title: ARK-T733 ark run start and ark evaluation record in a project with no companions make no Orca call and print what they printed before, also when only a worker.json of a removed companion is left
level: integration
technique: equivalence classes on project state (no companions key and no worker.json, no companions key with a recorded worker.json of a removed companion) with a call-counting fake orca
priority: medium
risk: "every ark run start and ark evaluation record of a project with no companion pays an Orca call (run-list, worker-list), so a slow or down Orca delays or breaks it; the commands print a new line or a changed line when no companion is involved; the command stops, wakes or releases the worker of a removed companion, which only sync may do; the check for no companion is made after the first Orca read"
status: active
changed_by: 2026-11-20-ARK-521-1
---

## Objective

Prove that the wake of ARK-T731 costs nothing when there is no companion to wake: no Orca call, and the same stdout and stderr as before this ticket. Serves ARK-521/AC5.

## Preconditions

- A temp `ARK_HOME` and a project `p` whose `ark.yml` has no `companions` key, and no `companions/` folder.
- The call-counting fake orca of ARK-T656 (every verb logged to `calls.jsonl` before any failure setting is checked, an empty log at the start).
- A second state: still no `companions` key, but `companions/gone/worker.json` of a removed companion with a dispatch id and a fake `worker-list` that holds its live row.
- Output baseline: the stdout and stderr that `ark run start` and `ark evaluation record` print on the same input before this ticket (the run id alone; one `recorded evaluation: ...` line; no stderr).

## Steps

1. In the first state, run `ark run start` for a new ticket and then `ark evaluation record` with blockers, and then with none. Read stdout, stderr, the exit code and the call log.
2. In the second state, run the same two commands. Read the call log, `companions/gone/`, and the live row of the fake.

## Expected results

- Step 1: the call log is empty (zero calls of any verb, not only no `send`); stdout is the run id alone for `run start` and the `recorded evaluation: ...` line for each record; stderr is empty; exit 0.
- Step 2: zero Orca calls; no `worker-stop`, no `send`, no release; `companions/gone/worker.json` and the live row are unchanged (sync stops it); stdout and stderr as in step 1.

## Screenshot checkpoints

None. The surface is CLI output; no screenshot applies.
