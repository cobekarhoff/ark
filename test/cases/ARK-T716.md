---
id: ARK-T716
title: ARK-T716 every phase the docs and skills name is one the reducer emits
level: unit
technique: equivalence classes (phase known or unknown), scan of docs, role skills and shared files
priority: medium
risk: "a doc, role skill or shared file names a phase (`phase `x``, or an arrow in a mermaid `stateDiagram-v2`) that the reducer never emits, so a run lead waits for a phase that never comes; a shared file left out of the scan list is never checked (ARK-579 adds engineering.md, which the scan reads through the same list as ARK-T410)"
status: active
changed_by: 2026-11-20-ARK-579-1
---

## Objective

Prove that every phase named in `CONTEXT.md`, `README.md`, `docs/explanation/architecture.md`, `docs/reference/cli.md`, the ten role skills (`skills/ark-*/SKILL.md`) and the four shared files (`skills/shared/`: `rules.md`, `worker-protocol.md`, `principles.md`, `engineering.md`) is a phase in `phases` of the reducer. The scan reads a phrase such as ``phase `x` `` and each arrow of a `stateDiagram-v2` block. ARK-579 adds `engineering.md` to the shared list, so this scan reads it too. The test shared its id ARK-T86 with the `--help` case of `test/project-flag.test.ts`; the validator renames it to ARK-T716.

Expected: When a doc or skill names a phase, the system shall name one that the reducer emits.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.
- The ten skill folders and the four shared files exist. The test fails when the glob finds fewer than ten skills or a shared file is missing, and when `architecture.md` names no phase, so an empty scan cannot pass.

## Steps

1. Run the test `ARK-T716 every phase the docs and skills name is one the reducer emits`.

## Expected results

- Each phase found is one of `phases` of the reducer.
- `docs/explanation/architecture.md` names at least one phase.

## Screenshot checkpoints

None. The surface is files; no screenshot applies.
