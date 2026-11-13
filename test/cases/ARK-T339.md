---
id: ARK-T339
title: "ARK-T339 an untouched file counts when a test that failed at head passes at the tip, even if another test of the file is red on main"
level: integration
technique: equivalence class (partial overlap of failing tests between head and the tip)
priority: high
risk: a file is forgiven because any test in it fails at the tip, so a test that the run broke merges hidden behind a test that was already red
status: active
changed_by: 2026-11-13-ARK-428-1
---

## Objective

Prove that a file is red on main only when every test that failed at head also fails at the tip.

## Preconditions

- Temporary `ARK_HOME` and git repo with an `origin` remote whose target branch holds `mixed.test` with tests `a` and `mixed`: `a` passes and `mixed` fails at the tip.
- The run breaks `a` at head without touching `mixed.test`, so both tests fail at head.

## Steps

1. Run `ark test <run>`.

## Expected results

- Exit 1, `passed: false`, no `red_on_main` in `test.completed`, and no line that starts with `red on main`.
- The output holds a `not red on main` line that names the file.

## Screenshot checkpoints

none: integration case on CLI output; no UI surface.
