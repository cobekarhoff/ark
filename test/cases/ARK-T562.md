---
id: ARK-T562
title: "ARK-T562 a failing automated criterion still makes passed false next to a manual ok"
level: integration
technique: "equivalence classes (automated fail with manual ok)"
priority: medium
risk: "a manual ok masks a failing automated criterion"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a failing automated criterion still makes passed false next to a manual ok. Converted on touch from ARK-283-AC1 by the ARK-386 campaign. Production owner: `cli/test-run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/test-run.test.ts` whose title starts with `ARK-T562`.

## Expected results

- The test passes: a failing automated criterion still makes passed false next to a manual ok.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
