---
id: ARK-T167
title: ARK-T167 ark status limits the config check and run state to the project named by ARK_PROJECT or --project
level: integration
technique: equivalence classes (valid project, broken project, unknown project) and decision table (ARK_PROJECT vs --project vs run id)
priority: medium
risk: status checks every project when one is named, so a broken sibling fails it; an unknown project passes silently; --project is ignored for run state
status: active
changed_by: 2026-11-09-ARK-340-1
---

## Objective

Prove that naming a project through `ARK_PROJECT` or `--project` limits the status config check to that project, and that `--project` also scopes run status.

## Preconditions

- A temporary `ARK_HOME` with a valid project `demo` and a project `broken` whose `ticket_source` is `trello`.
- A `demo` run awaiting criteria.
- The harnesses of the roles are on PATH.

## Steps

1. Run `ark status` with `ARK_PROJECT` set to `demo`, then `broken`, then `ghost`.
2. Run `ark status --project demo`, `ark status <run id> --project demo` and `ark status --project missing`.
3. Record each output and exit code.

## Expected results

- When the named project is valid, the system shall exit with code 0 and print no config error, whatever other projects hold.
- When the named project has an invalid config, the system shall exit with code 1.
- When the named project does not exist, the system shall exit with code 1 and name it on stderr.
- When `--project` names the run's project, the system shall print `phase: awaiting_criteria` for the run.

## Screenshot checkpoints

none: integration case on CLI output and exit code; no UI surface.
