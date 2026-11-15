---
id: ARK-T478
title: "ARK-T478 close handed_off uses the plural for several pending manual ACs"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: close handed_off uses the plural for several pending manual ACs"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that close handed_off uses the plural for several pending manual ACs. Converted on touch from ARK-304-AC2 by the ARK-386 campaign. Production owner: `cli/merge-request.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T478`.

## Expected results

- The test passes: close handed_off uses the plural for several pending manual ACs.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
