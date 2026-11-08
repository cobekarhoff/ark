---
id: ARK-T91
title: ARK-T91 old config loads but visible work requires a configured Designer
level: integration
technique: state transition on config
priority: medium
risk: An old config without roles.designer is refused at load, or strategy record accepts visible work without a Designer
status: active
changed_by: 2026-11-07-ARK-322-1
---

## Objective

Prove an ark.yml without roles.designer loads, and `ark strategy record` refuses a web_ui run until the designer is set. Converted on touch from ARK-173-AC10.

Expected: If roles.designer is missing, strategy record shall refuse visible work and name roles.designer.

## Preconditions

- The worktree on the latest commit of the branch, with dependencies installed.

## Steps

1. Run the test `ARK-T91 old config loads but visible work requires a configured Designer`.

## Expected results

- The test passes: an ark.yml without roles.designer loads, and `ark strategy record` refuses a web_ui run until the designer is set.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
