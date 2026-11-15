---
id: ARK-T544
title: "ARK-T544 a spent budget in building with no test or a passing test is answered by auto"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: a spent budget in building with no test or a passing test is answered by auto"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a spent budget in building with no test or a passing test is answered by auto. Converted on touch from ARK-288-AC1 by the ARK-386 campaign. Production owner: `cli/run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gates.test.ts` whose title starts with `ARK-T544`.

## Expected results

- The test passes: a spent budget in building with no test or a passing test is answered by auto.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
