---
id: ARK-T79
title: ARK-T79 loads old and chief-role configs
level: integration
technique: config load
priority: medium
risk: A config with or without roles.chief fails to load
status: active
changed_by: 2026-11-07-ARK-322-1
---

## Objective

Prove `ark status` accepts an ark.yml with and without roles.chief. Converted on touch from ARK-177-AC5.

Expected: When ark.yml has no roles.chief or has one, the system shall load it.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test `ARK-T79 loads old and chief-role configs`.

## Expected results

- The test passes: `ark status` accepts an ark.yml with and without roles.chief.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
