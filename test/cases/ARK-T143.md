---
id: ARK-T143
title: ARK-T143 the hand-off report lists each pending bump with its needed value
level: integration
technique: boundary values
priority: medium
risk: a hand-off line shows no needed value, or lists a bump out of repo order, so the human does not know what to move by hand
status: active
changed_by: 2026-11-09-ARK-338-1
---

## Objective

Prove that the hand-off report lists each pending bump with its needed value.

## Preconditions

A project has `merge_requests: none`. The plan has three repos in the order core, platform, reports: platform holds core as a submodule (pin `libs/core`), reports pins core as a package (`clara-core>=0.0.6rc1`), and neither bump step is done.

## Steps

1. Run `ark run close <run> handed_off`.

## Expected results

- The report lists, in this order, the branch line of core, the branch line of platform, `pending bump: bump-platform (submodule <core>, libs/core) needs <8 characters of the core head>`, the branch line of reports, and `pending bump: bump-reports (package <core>, clara-core>=0.0.6rc1) needs <published version>`.

Proof: `test/run.test.ts`.

## Screenshot checkpoints

None. The surface is CLI output.
