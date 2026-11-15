---
id: ARK-T559
title: "ARK-T559 ark test runs the suites in the run's workspace mirror and runs no compose when ark.yml has none"
level: integration
technique: "equivalence classes (compose configured or not)"
priority: medium
risk: "a head suite runs in the wrong folder, or compose runs when none is configured"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that ark test runs the suites in the run's workspace mirror and runs no compose when ark.yml has none. Converted on touch from ARK-154-AC3 by the ARK-386 campaign. Production owner: `cli/test-run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/test-run.test.ts` whose title starts with `ARK-T559`.

## Expected results

- The test passes: ark test runs the suites in the run's workspace mirror and runs no compose when ark.yml has none.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
