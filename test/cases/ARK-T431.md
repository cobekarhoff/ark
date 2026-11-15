---
id: ARK-T431
title: "ARK-T431 run start refuses a ticket with an open run and names it"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: run start refuses a ticket with an open run and names it"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that run start refuses a ticket with an open run and names it. Converted on touch from ARK-152-AC1 by the ARK-386 campaign. Production owner: `cli/run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T431`.

## Expected results

- The test passes: run start refuses a ticket with an open run and names it.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
