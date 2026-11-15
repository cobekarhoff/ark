---
id: ARK-T537
title: "ARK-T537 a gates value other than human or auto fails the load and names the field"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: a gates value other than human or auto fails the load and names the field"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that a gates value other than human or auto fails the load and names the field. Converted on touch from ARK-234-AC1 by the ARK-386 campaign. Production owner: `cli/config.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/gates.test.ts` whose title starts with `ARK-T537`.

## Expected results

- The test passes: a gates value other than human or auto fails the load and names the field.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
