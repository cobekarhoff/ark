---
id: ARK-T560
title: "ARK-T560 a criterion with manual: true shows manual pending, manual ok or manual problem, only manual ok exits 0, and the last answer decides"
level: integration
technique: "state transition (pending, ok, problem, ok) through the manual gate"
priority: medium
risk: "a manual criterion reads the wrong state from the gate, a problem answer is never replaced by a later ok, or manual pending exits 0"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a criterion with manual: true shows manual pending, manual ok or manual problem, only manual ok exits 0, and the last answer decides. Converted on touch from ARK-283-AC1 by the ARK-386 campaign. Production owner: `cli/lifecycle.ts, cli/test-run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/test-run.test.ts` whose title starts with `ARK-T560`.

## Expected results

- The test passes: a criterion with manual: true shows manual pending, manual ok or manual problem, only manual ok exits 0, and the last answer decides.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
