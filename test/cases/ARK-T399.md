---
id: ARK-T399
title: ARK-T399 run start refuses an invalid ark.yml and names the field
level: integration
technique: "equivalence classes, one valid config with exactly one invalid field per row"
priority: medium
risk: "run start accepts an ark.yml with a missing or invalid field and creates a run, or refuses it with an error that does not name the field, so the human cannot find what to fix"
status: active
changed_by: 2026-11-13-ARK-332-1
---

## Objective

Prove that `ark run start` refuses a project whose `ark.yml` holds one invalid field, exits 1, names the field in the error, and creates no run folder.

## Preconditions

- A temp ARK_HOME.
- A project `broken` whose `ark.yml` is valid except for one field. One row for each invalid field:
  - a missing `workspace`
  - a `workspace` that does not exist
  - an unknown `ticket_source` (`trello`)
  - a suite with an unknown parser (`junit`) and a command that writes its report to `{report}`
  - empty `suites`
  - a missing `roles.reviewer`
  - a negative `round_budget` (`-1`)
- A local ticket file `ARK-902` with one AC.

## Steps

1. Run `ark run start <ticket file> --project broken` as a process.
2. Read the exit code, stderr, and the `runs` folder of the project.

## Expected results

- The command exits with code 1.
- Stderr names the field: `workspace`, `workspace`, `ticket_source must be one of local, github, jira`, `suites[1].parser must be one of bun, pytest, behave`, `suites`, `roles.reviewer` and `round_budget`, one for each row in the order above.
- The project has no `runs` folder.

## Screenshot checkpoints

none: the case reads an exit code, stderr and a folder.
