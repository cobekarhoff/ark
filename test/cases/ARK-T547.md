---
id: ARK-T547
title: "ARK-T547 an event refused outside its phases names the phases that allow it"
level: integration
technique: "error guessing (the refusal path)"
priority: medium
risk: "the contract breaks unnoticed: an event refused outside its phases names the phases that allow it"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that an event refused outside its phases names the phases that allow it. Given a case id by the ARK-386 campaign; it had no id. Production owner: `cli/transitions.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gates.test.ts` whose title starts with `ARK-T547`.

## Expected results

- The test passes: an event refused outside its phases names the phases that allow it.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
