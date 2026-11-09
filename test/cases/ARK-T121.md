---
id: ARK-T121
title: ARK-T121 a quick ark test runs the changed files at head only and does not open the MR, a full ark test does
level: integration
technique: state transition (no test, quick, full, new commit after full) at the merge-request and close gates
priority: high
risk: a quick pass is taken as a gate pass and a run ships with an unchanged test broken by its source change; or an old test.completed event without mode refuses a run in flight; or a commit after the full run still opens the MR or closes handed_off; or a handed_off close refuses after a current-head full run
status: active
changed_by: 2026-11-08-ARK-389-1
---

## Objective

Prove that `ark test <run> --quick` runs the changed test files of the selected suites at head only (no base run, no whole-suite head run) and records `mode: quick` in `test.completed` and in `last_test`; that `ark merge-request open` and `ark run close <run> handed_off` each refuse unless the last test at the current head is a full run, naming the command `ark test <run>`; that each proceeds after a full run at the current head; and that each refuses again after a commit follows the full run. Serves ARK-389/AC3.

Expected: When the last test at the current head is quick, or a full test is at an older head, the system shall refuse `merge-request open` and a handed_off close and name `ark test <run>`; when it is a full run at the current head, the system shall proceed.

## Preconditions

- A temporary `ARK_HOME`, project, git repo and a fake forge so `ark merge-request open` can run. All other merge-request and close gates are satisfied, so the mode check is the only possible refusal.
- A suite with `base_files` and `base_command`. Each fixture run is `kind: feature` with its own run folder and branch: one changed test file `test/own.test.ts` and one unchanged `test/untouched.test.ts`. Both write a marker file. `test/untouched.test.ts` fails in run Q and passes in runs F1 to F3.
- Fixture runs, one for each command so no transition consumes the state that a later one needs: Q (quick result), F1 (full result at head, for `merge-request open`), F2 (full result at head, for the handed_off close), F3 (full result, then a new commit, for both commands), F4 (an old `test.completed` event with no `mode` field at the current head with `passed: true`).

## Steps

1. Run `ark test Q --quick`. Read the output, marker files, the `test.completed` event and `ark run state`.
2. On Q run `ark merge-request open Q`, then `ark run close Q handed_off`.
3. On F1 run `ark test F1`, then `ark merge-request open F1`.
4. On F2 run `ark test F2`, then `ark run close F2 handed_off`.
5. On F3 run `ark test F3`, add a commit to the branch, then run `ark merge-request open F3` and `ark run close F3 handed_off`.
6. On F4 run `ark merge-request open F4`.

## Expected results

- Step 1: only `test/own.test.ts` ran, at head; no base marker and no `base` line; exit 0 although `test/untouched.test.ts` would fail; the event and `last_test` carry `mode: quick`; the output says the result is not a gate.
- Step 2: both commands exit non-zero. Each error says the last test at this head is quick and names `ark test Q`. No MR is opened and the run does not close.
- Step 3: the full run runs the whole head suite (both marker files) and records `mode: full`; the MR opens.
- Step 4: the full run records `mode: full`; the run closes handed_off.
- Step 5: both commands exit non-zero, because the last full test is not at the current head; each error names `ark test F3`.
- Step 6: the MR is not refused for mode (an event with no `mode` reads as full).

## Screenshot checkpoints

none: integration case on CLI output, exit codes and files; no UI surface.
