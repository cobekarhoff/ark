---
id: ARK-T767
title: ARK-T767 ark status lists the open runs of every project with no project named, and only the open runs of the project that --project or ARK_PROJECT names
level: integration
technique: "equivalence classes (no project named, --project, ARK_PROJECT; named project with an open run, named project with no open run) and the format of a run line"
priority: high
risk: "a named project still lists the open runs of every project, so a second project's Master Chief counts the runs of Ark against its concurrency and its auto-merger reads them; or the fix drops runs with no project named, changes the columns the auto-merger's awk reads, lists a closed run, or falls back to every project when the named project has no open run"
status: active
changed_by: 2026-11-21-ARK-622-1
---

## Objective

Prove that `ark status` without a run argument prints one line for each open run (run id, phase, current step, age) of every project when no project is named, and only the open runs of the named project when `--project` or `ARK_PROJECT` names one. A closed run is never listed. The case takes over the list contract of ARK-T165 (retired) and extends its fixture.

## Preconditions

- A temporary `ARK_HOME` with projects `demo`, `other` and `quiet`, each with a valid `ark.yml`.
- A `demo` run with an approved plan and step `build` started.
- An `other` run with no plan yet (`awaiting_criteria`).
- A `demo` run closed as `aborted`.
- `quiet` has no run.
- The harnesses of the roles are on PATH, so `ark status` exits 0.
- `ARK_PROJECT` is unset before step 1 and unset again after step 3, even when a step fails.

## Steps

1. Run `ark status`.
2. Run `ark status --project other`.
3. Run `ark status` with `ARK_PROJECT=other`.
4. Run `ark status --project quiet`.
5. Record each output and exit code.

## Expected results

- When no project is named, the system shall exit with code 0 and print `<demo run id>  building  build  0m` and `<other run id>  awaiting_criteria  -  0m` as two separate lines.
- When no project is named, the system shall not print the id of the closed run.
- When `--project other` is set, the system shall exit with code 0, print `<other run id>  awaiting_criteria  -  0m`, and print neither the id of the open `demo` run nor the id of the closed run.
- When `ARK_PROJECT=other` is set and no `--project` is given, the system shall print the same run lines as step 2.
- When `--project quiet` names a project with no open run, the system shall print `no open runs` and no run id of `demo` or `other`.

## Screenshot checkpoints

none: integration case on CLI output and exit code; no UI surface.
