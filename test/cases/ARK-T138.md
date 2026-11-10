---
id: ARK-T138
title: ARK-T138 status shows a submodule bump that points at the upstream branch
level: integration
technique: equivalence classes
priority: high
risk: a submodule bump shows no pin, or shows a pointer that is not the commit in the downstream branch
status: active
changed_by: 2026-11-09-ARK-338-1
---

## Objective

Prove that status shows a submodule bump that points at the upstream branch.

## Preconditions

A plan has a submodule edge `core` with pin `libs/lib` and the bump step bump-lib, no `bump.refreshed` is recorded, the downstream branch holds a gitlink at `libs/lib`, and the upstream MR is open.

## Steps

1. Run `ark merge-request status <run>`.

## Expected results

- The status prints ` bump bump-lib  submodule core  pin libs/lib  points at upstream branch` and the first 8 characters of the gitlink commit.

Proof: `test/merge-request-status.test.ts`.

## Screenshot checkpoints

None. The surface is CLI output.
