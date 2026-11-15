---
id: ARK-T554
title: "ARK-T554 an amend keeps manual: true on the criterion"
level: integration
technique: "state transition through the CLI on fixture files"
priority: medium
risk: "the contract breaks unnoticed: an amend keeps manual: true on the criterion"
status: active
changed_by: 2026-11-14-ARK-386-1
---

## Objective

Prove that an amend keeps manual: true on the criterion. Converted on touch from ARK-283-AC1 by the ARK-386 campaign. Production owner: `cli/criteria.ts`.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test of `test/criteria-amend.test.ts` whose title starts with `ARK-T554`.

## Expected results

- The test passes: an amend keeps manual: true on the criterion.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
