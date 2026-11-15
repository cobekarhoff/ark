---
id: ARK-T439
title: "ARK-T439 round_budget of ark.yml reaches the run"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: round_budget of ark.yml reaches the run"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that round_budget of ark.yml reaches the run. Converted on touch from ARK-152-AC2 by the ARK-386 campaign. Production owner: `cli/config.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T439`.

## Expected results

- The test passes: round_budget of ark.yml reaches the run.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
