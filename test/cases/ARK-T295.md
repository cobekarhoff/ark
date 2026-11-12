---
id: ARK-T295
title: "ARK-T295 auto-merger sends one 'Merged: <run> !<number>' message to the Master Chief Run after a merge and keeps looping, and logs the notice when no such Run exists"
level: integration
technique: "equivalence classes (Master Chief Run present on page 2, Run absent) and state transition (merged once, later passes repeat nothing)"
priority: high
risk: "the script still exits after a merge (launchd restarts it and the signal is lost); it sends the same message each pass or after a restart; it sends to the wrong Run or misses the Run on the second run-list page; with no Run it crashes or loses the notice instead of logging; conflict, merge failed and all merged lines repeat every pass"
status: active
changed_by: 2026-11-12-ARK-358-1
---

## Objective

After `scripts/auto-merger.sh` merges an MR it sends one `orca orchestration send --to run:<id> --type status --subject 'Merged: <run> !<number>'` to the Run named `Master Chief: <project> tickets`, then runs the next pass. With no such Run it writes the notice to its log and goes on.

## Preconditions

- Fake `gh`, `ark`, `osascript` and a fake `orca` in a bin folder (as `test/chief-scripts.test.ts`). The fake `orca` answers `run-list` with a `nextCursor` on page 1 and the Master Chief Run (name `Master Chief: ark tickets`) only on page 2, a decoy `Master Chief: other tickets` Run, and logs each `send` with all arguments.
- A project `ark` with a CLEAN MR whose run has `retro.md`, a state file location for the script in a scratch dir, `ARK_PROJECT=ark`.

## Steps

1. Run `auto-merger.sh <workspace> 1` in the background with the Run present. Wait until the merge is logged.
2. Wait for at least two further passes. Kill the script; check it was still alive until the kill.
3. Count `send` calls in the fake orca log and read subject and target.
4. Start the script again (a launchd restart) with the same state and a still-merged run; wait one pass.
5. Make a second CLEAN MR; wait for its merge.
6. Repeat step 1 with a fake `orca` whose `run-list` has no Master Chief Run.
7. With a conflicting MR and a failed merge present, run several passes.

## Expected results

- Steps 1-3: the process is alive after the merge and the later passes; exactly one `send`, to `run:<id of the ark Run>` (not the decoy), `--type status`, subject `Merged: <run> !<number>` with `!`, not `#`.
- Step 4: no repeat send.
- Step 5: one new send with the new number; two total.
- Step 6: no `send`; the notice text is in the script's log; the script is alive and merged the MR.
- Step 7: each conflict, merge failed or all merged line is sent or logged at most once per condition, per the plan's decision.
- Existing tests that waited for exit (ARK-T-ids of the old titles at test/chief-scripts.test.ts lines 148, 152, 395-489) move to `--once` and keep their assertions.

## Screenshot checkpoints

none: script and log output, no UI.
