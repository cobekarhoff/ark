---
id: ARK-T328
title: "ARK-T328 an untouched file that fails at the run's head and passes at the tip of the target branch still fails the run and prints no red on main line"
level: integration
technique: "equivalence class (untouched, passes on main) with a state-change cause: a helper changed by the run"
priority: high
risk: every untouched failure is treated as red on main, so a run that breaks a file through a changed helper merges with a broken test
status: active
changed_by: 2026-11-13-ARK-428-1
---

## Objective

Prove that red on main requires a failure on main: an untouched file that the run broke still fails the run.

## Preconditions

- Temporary `ARK_HOME` and git repo with an `origin` remote whose target branch tip holds `helper.ts` (returns 1) and `uses-helper.test` (asserts `helper() === 1`, passes).
- The run changes `helper.ts` to return 2 and does not touch `uses-helper.test`. A second untouched file, `red.test`, fails on the tip too.

## Steps

1. Run `ark test <run>` with only `uses-helper.test` as the failure. Read the output, exit code and `test.completed`.
2. Run `ark test <run>` with `red.test` also present. Read the same.

## Expected results

- Step 1: `uses-helper.test` fails at head, starts twice at head and once at the tip checkout, passes there. Exit code 1. The output has no line that starts with `red on main`. `test.completed` has `passed: false` and no red-on-main field. `ark status` shows the failure.
- Step 2: exit 1. `red.test` is printed as red on main and `uses-helper.test` as a failure: one red on main file does not hide the other failure.

## Screenshot checkpoints

none: integration case on CLI output, events and processes; no UI surface.
