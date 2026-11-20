---
id: ARK-T103
title: ARK-T103 the CI command sequence blocks each failed check
level: integration
technique: equivalence classes (one defect per check) on a fixture project
priority: medium
risk: a failing typecheck, lint, format or test command no longer stops the CI command sequence, so a defect merges
status: active
changed_by: 2026-11-19-ARK-571-1
---

## Objective

Prove that the CI command sequence (the static-check commands and the Bun shard command of `ci.yml`) runs clean on a valid fixture project and stops at the failing command for each of four defects. ARK-571 splits the old single `test` job into a static-checks job and a shard matrix: the case reads both jobs, so it fails when a command is dropped from either.

## Preconditions

- A temporary fixture project with valid source, typecheck, lint, format and test setup. Real commands, no mocks.

## Steps

1. Read the commands from `ci.yml` with `Bun.YAML.parse`: the `run` steps of the static-checks job (`bun run typecheck`, `bun run lint`, `bun run format:check`) and the `bun test` step of the shard job. Replace `${{ matrix.shard }}` by `1` in that step, and write a timings file at the path of its `--timings` flag in the fixture, listing the fixture's test file.
2. Run the CI command sequence on the valid project.
3. For each defect (type error, lint error, format drift, failing test), add the defect file and run the sequence again.

## Expected results

- When the project is valid, no command shall fail.
- When a defect is added, the sequence shall stop at the check that the defect breaks, and its output shall name that command. The failing-test defect shall be caught by the Bun shard step with its real `--shard` and `--timings` flags.

## Screenshot checkpoints

none: integration case on command exit codes.
