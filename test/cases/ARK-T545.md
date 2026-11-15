---
id: ARK-T545
title: "ARK-T545 a start refused for another reason (running step, --merge with no failed sync) leaves no auto answer"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: a start refused for another reason (running step, --merge with no failed sync) leaves no auto answer"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a start refused for another reason (running step, --merge with no failed sync) leaves no auto answer. Converted on touch from ARK-288-AC1 by the ARK-386 campaign. Production owner: `cli/run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gates.test.ts` whose title starts with `ARK-T545`.

## Expected results

- The test passes: a start refused for another reason (running step, --merge with no failed sync) leaves no auto answer.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
