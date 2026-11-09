---
id: ARK-T140
title: ARK-T140 status shows a package bump that waits for the upstream publish
level: integration
technique: state transition
priority: high
risk: a merged upstream shows no publish wait, so the bump is lost or refreshed with a version that is not published
status: active
changed_by: 2026-11-09-ARK-338-1
---

## Objective

Prove that status shows a package bump that waits for the upstream publish.

## Preconditions

A plan has a package edge with a bump step, no refresh is recorded, and the upstream MR is merged.

## Steps

1. Run `ark merge-request status <run>`.

## Expected results

- The bump line shows `waits for upstream publish`.

Proof: `test/merge-request-status.test.ts`.

## Screenshot checkpoints

None. The surface is CLI output.
