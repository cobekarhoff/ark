---
id: ARK-T557
title: "ARK-T557 untagged tests never prove an AC and each AC gets passing, failing or missing"
level: integration
technique: "equivalence classes of the old tag path (passing, failing, missing, untagged)"
priority: medium
risk: "a tagged test fails to decide an AC, or an untagged test or a unit-only test proves one"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that untagged tests never prove an AC and each AC gets passing, failing or missing. Converted on touch from ARK-154-AC5 by the ARK-386 campaign. Production owner: `cli/test-run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/test-run.test.ts` whose title starts with `ARK-T557`.

## Expected results

- The test passes: untagged tests never prove an AC and each AC gets passing, failing or missing.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
