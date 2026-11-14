---
id: ARK-T552
title: "ARK-T552 an empty text file is refused, nothing changes"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: an empty text file is refused, nothing changes"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that an empty text file is refused, nothing changes. Converted on touch from ARK-207-AC2 by the ARK-386 campaign. Production owner: `cli/criteria.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/criteria-amend.test.ts` whose title starts with `ARK-T552`.

## Expected results

- The test passes: an empty text file is refused, nothing changes.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
