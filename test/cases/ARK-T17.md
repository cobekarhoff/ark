---
id: ARK-T17
title: ARK-T17 ark status flags a project folder with runs but no ark.yml
level: integration
technique: equivalence classes (folder without ark.yml, with at least one run folder) and boundary on the run count (one run)
priority: high
risk: a project that lost its ark.yml but still holds runs is hidden from ark status, so the broken config goes unnoticed and ark status exits 0
status: active
changed_by: 2026-11-06-ARK-321-1
---

## Objective

Prove that a folder under `$ARK_HOME/projects` with no `ark.yml` and at least one run folder under `runs/` is an invalid project. `ark status` names it, reports the invalid config count, and exits 1. A run folder is any directory entry under `runs/`.

## Preconditions

- A temporary `ARK_HOME` holds `projects/orphan/` with no `ark.yml`.
- The folder `projects/orphan/runs/` holds one directory, for example `runs/2026-01-01-X-1/`.

## Steps

1. Run `ark status` with `ARK_HOME` set to the temporary directory.
2. Record the output and the exit code.

## Expected results

- When `ark status` runs, the system shall print "project orphan has no ark.yml".
- When `ark status` runs, the system shall print "project config(s) invalid".
- When `ark status` finds a project folder with no `ark.yml` and a run folder, the system shall exit with code 1.

## Screenshot checkpoints

none: integration case on CLI output and exit code; no UI surface.
