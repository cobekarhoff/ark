---
id: ARK-T327
title: "ARK-T327 an untouched file that fails at the run's head and at the tip of the target branch is printed as red on main, recorded in test.completed, and does not fail the run"
level: integration
technique: equivalence class (untouched, fails on main) with boundaries on the flaky retry order, the no-base_command, no-file, no-origin and failed-fetch fallbacks, and the cached reuse
priority: high
risk: a failure of main spends the run's budget and blocks the merge request; or the file is silently dropped (no red on main line, no event field); or a suite that cannot run one file at main (no base_command, failed test with no file), a repo with no `origin` or a failed `git fetch origin` crashes or hides a real failure; or a reused suite loses the red on main list
status: active
changed_by: 2026-11-13-ARK-428-1
---

## Objective

Prove that an untouched file failing at head and at the tip of the target branch is reported as red on main, not counted, and that the run passes.

## Preconditions

- Temporary `ARK_HOME` and git repo with an `origin` remote. The target branch tip on `origin` holds `red.test` (always fails) and `ok.test` (always passes). The run's worktree starts from that tip.
- The run's diff changes only a third file, `other.test` (passes). Every start of a file appends a line to its own counter file.
- A second suite variant with no `base_command`, and a third whose failed test has no `file` in the junit result. A fourth repo has no `origin` remote; a fifth has an `origin` whose `git fetch` fails (unreachable path).

## Steps

1. Run `ark test <run>`. Read the output, the exit code, `results/`, the counter files and the `test.completed` event.
2. Run `ark test <run>` again with nothing changed. Read the output.
3. Run `ark test <run> --quick`. Read the `test.completed` event.
4. Run the suite with no `base_command`, then the suite whose failed test has no `file`.
5. Run `ark test <run>` in the repo with no `origin` remote, then in the repo whose fetch fails. Each has an untouched file that fails at head.
6. Move `origin`'s target branch ahead of the run's base with a new commit that fixes `red.test`, then run `ark test <run>` in a fresh run.

## Expected results

- Step 1: `red.test` fails at head, starts twice at head (flaky retry first) and once at the tip checkout; `ok.test` and `other.test` start once at head. The output has a line that starts with `red on main` and names `red.test`. `test.completed` has `passed: true` and a red-on-main list holding exactly `red.test`. Exit code 0. `red.test` is not in the failed list, not in `flaky`.
- Step 2: the reused suite still prints the `red on main` line and the event still carries the list.
- Step 3: the quick `test.completed` has no red-on-main field and no `red on main` line.
- Step 4: the failure keeps counting: exit 1, no `red on main` line, `passed: false`; the output says why the file was not checked on main.
- Step 5: no crash. The failure keeps counting: exit 1, `passed: false`, no `red on main` line, and the output prints the reason (no `origin` remote, or fetch failed).
- Step 6: the checked tip is the fetched `origin/<target>`, not the run's base: `red.test` passes there, so the failure counts and the run exits 1 with no `red on main` line.

## Screenshot checkpoints

none: integration case on CLI output, events and processes; no UI surface.
