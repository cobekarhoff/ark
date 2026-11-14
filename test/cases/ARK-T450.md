---
id: ARK-T450
title: "ARK-T450 an unknown command exits 1 and prints usage"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: an unknown command exits 1 and prints usage"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that an unknown command exits 1 and prints usage. Given a case id by the ARK-386 campaign; it had no id. Production owner: `cli/ark.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T450`.

## Expected results

- The test passes: an unknown command exits 1 and prints usage.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
