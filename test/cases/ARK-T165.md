---
id: ARK-T165
title: ARK-T165 ark status without a run lists every open run with its phase and current step across projects, and omits closed runs
level: integration
technique: equivalence classes (run building, run awaiting criteria in another project, closed run)
priority: medium
risk: status lists only one project, drops the phase or current step, or lists a closed run
status: active
changed_by: 2026-11-09-ARK-340-1
---

## Objective

Prove that `ark status` with no run argument prints one line per open run across all projects, with run id, phase, current step and elapsed time, and does not list a closed run.

## Preconditions

- A temporary `ARK_HOME` with projects `demo` and `other`, both with a valid `ark.yml`.
- A `demo` run with an approved plan and step `build` started.
- An `other` run with no plan yet.
- A `demo` run closed as `aborted`.
- The harnesses of the roles are on PATH.

## Steps

1. Run `ark status`.
2. Record the output and the exit code.

## Expected results

- When `ark status` runs, the system shall exit with code 0.
- When a run is building, the system shall print `<run id>  building  build  0m`.
- When a run in another project awaits criteria, the system shall print `<run id>  awaiting_criteria  -  0m`.
- When a run is closed, the system shall not print its run id.

## Screenshot checkpoints

none: integration case on CLI output and exit code; no UI surface.
