---
id: ARK-T141
title: ARK-T141 status shows a refreshed bump
level: integration
technique: state transition
priority: high
risk: a recorded refresh does not show, so the run lead refreshes the same bump again
status: active
changed_by: 2026-11-09-ARK-338-1
---

## Objective

Prove that status shows a refreshed bump.

## Preconditions

A plan has a package edge with a bump step, and the upstream MR is merged.

## Steps

1. Run `ark bump refresh <run> bump-lib --to 0.0.6rc1`.
2. Run `ark merge-request status <run>`.

## Expected results

- The refresh exits 0 and prints `refreshed bump-lib to 0.0.6rc1`.
- The bump line shows `refreshed to 0.0.6rc1`.

Proof: `test/merge-request-status.test.ts`.

## Screenshot checkpoints

None. The surface is CLI output.
