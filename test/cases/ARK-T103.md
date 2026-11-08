---
id: ARK-T103
title: ARK-T103 the CI command sequence blocks each failed check
level: integration
technique: equivalence classes (one defect per check) on a fixture project
priority: medium
risk: a failing typecheck, lint, format or test command no longer stops the CI command sequence, so a defect merges
status: active
changed_by: 2026-11-07-ARK-330-1
---

## Objective

Prove that the CI command sequence runs clean on a valid fixture project and stops at the failing command for each of four defects.

## Preconditions

- A temporary fixture project with valid source, typecheck, lint, format and test setup. Real commands, no mocks.

## Steps

1. Run the CI command sequence on the valid project.
2. For each defect (type error, lint error, format drift, failing test), add the defect file and run the sequence again.

## Expected results

- When the project is valid, no command shall fail.
- When a defect is added, the sequence shall stop at the check that the defect breaks, and its output shall name that command.

## Screenshot checkpoints

none: integration case on command exit codes.
