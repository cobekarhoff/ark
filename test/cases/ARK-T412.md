---
id: ARK-T412
title: ARK-T412 every portless, orca tab create and ark ui command in the run-lead skill, the worker skills and the worker protocol has a form the CLI accepts
level: unit
technique: equivalence classes (accepted form, rejected form) over commands quoted in the skills; counts that keep the scan non-vacuous
priority: medium
risk: "a skill quotes a portless, orca tab create or ark ui command in a form the CLI refuses (no app port, a bad port, missing or extra flags, a bad hub name), so an agent that copies it fails; after the worker playbook is split, the scan reads files that no longer hold the commands and passes empty"
status: active
changed_by: 2026-11-14-ARK-414-1
---

## Objective

Prove that each quoted `portless`, `orca tab create` and `ark ui` command in `skills/ark-run-lead/SKILL.md`, the five worker skills (`ark-evaluator`, `ark-designer`, `ark-implementer`, `ark-validator`, `ark-reviewer`) and `skills/shared/worker-protocol.md` has a form the CLI accepts, that the checker rejects the bad forms, and that it sees the commands. Converted on touch from ARK-299-AC3, which read `run-lead.md` and `worker.md`.

Expected: When a skill quotes a portless, orca tab create or ark ui command, the system shall accept its form.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.
- The designer skill carries the `portless` commands and `ark ui --port`; the run-lead skill carries `orca tab create`.

## Steps

1. Run the test `ARK-T412 every portless, orca tab create and ark ui command in the run-lead skill, the worker skills and the worker protocol has a form the CLI accepts`.

## Expected results

- No quoted command of the seven files has a problem.
- Each rejected form (`orca tab create` without `--worktree`, a bad flag, an extra flag; `portless` with a missing, zero or too large app port or no command) is reported once.
- The checker sees at least 4 `portless <name> --app-port` commands, 2 `orca tab create` commands and 1 `ark ui --port` command over the seven files.

## Screenshot checkpoints

None. The surface is files; no screenshot applies.
