---
id: ARK-T16
title: ARK-T16 ark status skips a project folder that holds no run
level: integration
technique: equivalence classes (runs/ empty, runs/ missing, runs/ holding only a stray file) and boundary on the run count (zero runs)
priority: high
risk: a folder under $ARK_HOME/projects with no ark.yml and no run folder is listed or counted as an invalid project, so ark status exits 1 on a harmless leftover folder
status: active
changed_by: 2026-11-06-ARK-321-1
---

## Objective

Prove that a folder under `$ARK_HOME/projects` with no `ark.yml` and no run folder is not a project. `ark status` neither lists it nor counts it as invalid, and exits 0. A run folder is any directory entry under `runs/`. A stray file does not count. Every consumer of `listProjects` in `cli/paths.ts`, namely `ark status`, `ark chief state` and the hub, skips such a folder the same way.

## Preconditions

- A temporary `ARK_HOME` holds `projects/good/ark.yml`, a valid project config, with no runs.
- The folder `projects/empty-runs/` has no `ark.yml` and an empty `runs/` directory.
- The folder `projects/no-runs/` has no `ark.yml` and no `runs/` directory.
- The folder `projects/stray-file/` has no `ark.yml`. Its `runs/` directory holds one regular file (for example `runs/notes.txt`) and no directory.

## Steps

1. Run `ark status` with `ARK_HOME` set to the temporary directory.
2. Record the output and the exit code.
3. Run `ark chief state` with the same `ARK_HOME`. Read the project list in its output.

## Expected results

- When `ark status` runs and the only folders without `ark.yml` hold no run folder, the system shall exit with code 0.
- When `ark status` runs, the system shall list project `good`.
- When `ark status` runs, the system shall print none of `empty-runs`, `no-runs` and `stray-file`.
- When `ark status` runs, the system shall not print "project <name> has no ark.yml" or "project config(s) invalid" for these folders.
- When `runs/` is empty, missing, or holds only a stray file, the system shall treat the folder as no project, because `listProjects` in `cli/paths.ts` skips it.
- When `ark chief state` runs, the system shall skip these folders, because it reads projects through `listProjects` in `cli/paths.ts`.
- When the hub loads its project list, the system shall skip these folders for the same reason: it also uses `listProjects` in `cli/paths.ts`.

## Screenshot checkpoints

none: integration case on CLI output and exit code; no UI surface.
