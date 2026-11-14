---
id: ARK-T411
title: ARK-T411 changed skills and tests pass oxfmt --check
level: unit
technique: formatter check on named files
priority: low
risk: "the brainstorm or chief skill, or the tests that guard them, are not formatted, so `bun run format:check` fails in CI; the files move and the check silently skips a missing path"
status: active
changed_by: 2026-11-14-ARK-414-1
---

## Objective

Prove that `skills/ark-brainstorm/SKILL.md`, `skills/ark-chief/SKILL.md`, `test/playbooks.test.ts` and `test/brainstorm.test.ts` pass `oxfmt --check`. Converted on touch from ARK-289-AC5, whose paths (`skills/ark/playbooks/`) are gone.

Expected: When oxfmt checks the brainstorm and chief skills, the system shall report no change needed.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.
- The four files exist. The test fails when one is missing, so a moved file cannot be skipped.

## Steps

1. Run the test `ARK-T411 changed skills and tests pass oxfmt --check`.

## Expected results

- `oxfmt --check` exits 0 for the four files.

## Screenshot checkpoints

None. The surface is files; no screenshot applies.
