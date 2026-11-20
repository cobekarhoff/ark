---
id: ARK-T410
title: ARK-T410 every literal `ark run close <run> <outcome>` in the skills uses a known outcome
level: unit
technique: equivalence classes (outcome known or unknown), scan of every role skill and shared file
priority: medium
risk: "a skill quotes `ark run close <run> <outcome>` with an outcome the CLI refuses, so a run lead that copies it is refused at close; after the move to ten skill folders the scan reads no file and passes without checking anything; a new shared file that is not in the scan list is never checked for run close outcomes (ARK-579 adds engineering.md)"
status: active
changed_by: 2026-11-20-ARK-579-1
---

## Objective

Prove that every literal `ark run close <run> <outcome>` in the ten role skills (`skills/ark-*/SKILL.md`) and the four shared files (`skills/shared/`: `rules.md`, `worker-protocol.md`, `principles.md`, `engineering.md`) names an outcome that `cli/lifecycle.ts` lists. Converted on touch from ARK-187-AC3, whose folder (`skills/ark/playbooks`) is gone.

Expected: When a skill names `ark run close`, the system shall use a known outcome.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.
- The ten skill folders and `skills/shared/rules.md`, `worker-protocol.md`, `principles.md` and `engineering.md` exist. The test fails when the glob finds fewer than ten skills or one of the four shared files is missing, so an empty scan cannot pass.

## Steps

1. Run the test `ARK-T410 every literal \`ark run close <run> <outcome>\` in the skills uses a known outcome`.

## Expected results

- Each outcome found is one of `outcomes` in `cli/lifecycle.ts`.
- `skills/ark-run-lead/SKILL.md` holds at least one such literal.

## Screenshot checkpoints

None. The surface is files; no screenshot applies.
