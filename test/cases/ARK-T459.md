---
id: ARK-T459
title: "ARK-T459 run close releases each settled unreleased dispatch over paged lists"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: run close releases each settled unreleased dispatch over paged lists"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that run close releases each settled unreleased dispatch over paged lists. Converted on touch from ARK-278-AC1 by the ARK-386 campaign. Production owner: `cli/orca-release.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T459`.

## Expected results

- The test passes: run close releases each settled unreleased dispatch over paged lists.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
