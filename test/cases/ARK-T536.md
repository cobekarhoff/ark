---
id: ARK-T536
title: "ARK-T536 criteria accept refuses a new-scheme method test AC with empty verified_by and takes the fixed ticket"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: criteria accept refuses a new-scheme method test AC with empty verified_by and takes the fixed ticket"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that criteria accept refuses a new-scheme method test AC with empty verified_by and takes the fixed ticket. Converted on touch from ARK-311-AC5 by the ARK-386 campaign. Production owner: `cli/gate.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gate.test.ts` whose title starts with `ARK-T536`.

## Expected results

- The test passes: criteria accept refuses a new-scheme method test AC with empty verified_by and takes the fixed ticket.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
