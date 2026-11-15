---
id: ARK-T447
title: "ARK-T447 merged and abandoned need an MR, handed_off a test"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: merged and abandoned need an MR, handed_off a test"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that merged and abandoned need an MR, handed_off a test. Converted on touch from ARK-152-AC7 by the ARK-386 campaign. Production owner: `cli/run.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/run.test.ts` whose title starts with `ARK-T447`.

## Expected results

- The test passes: merged and abandoned need an MR, handed_off a test.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
