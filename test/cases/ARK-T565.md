---
id: ARK-T565
title: "ARK-T565 a failing check records passed false, prints check <name> failed and the last 20 lines before the suites"
level: integration
technique: "equivalence classes (check fails) and output order"
priority: medium
risk: "a failing check does not fail the run, prints the wrong lines or prints them after the suites"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a failing check records passed false, prints check <name> failed and the last 20 lines before the suites. Converted on touch from ARK-302-AC1 by the ARK-386 campaign. Production owner: `cli/test-run.ts (checks)`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/test-run.test.ts` whose title starts with `ARK-T565`.

## Expected results

- The test passes: a failing check records passed false, prints check <name> failed and the last 20 lines before the suites.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
