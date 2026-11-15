---
id: ARK-T563
title: "ARK-T563 a manual criterion with a passing tagged test is still decided by the manual gate"
level: integration
technique: "precedence (manual gate over tag)"
priority: medium
risk: "a passing tagged test marks a manual criterion passing before the human answers"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a manual criterion with a passing tagged test is still decided by the manual gate. Converted on touch from ARK-283-AC1 by the ARK-386 campaign. Production owner: `cli/test-run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/test-run.test.ts` whose title starts with `ARK-T563`.

## Expected results

- The test passes: a manual criterion with a passing tagged test is still decided by the manual gate.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
