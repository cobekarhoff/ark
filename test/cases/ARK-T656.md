---
id: ARK-T656
title: ARK-T656 ark companions sync starts a listed companion with no live worker, keeps a live one, stops a removed one, prints running, started or stopped for each, and ark chief state runs the same sync in its own section
level: integration
technique: state transition (no worker, started, running, entry removed, stopped) with a fake orca that holds a live worker list; equivalence classes on orca failure (no Master Chief run, worker-start fails, worker-stop fails, orca down)
priority: high
risk: "sync starts a second worker for a companion that runs (a duplicate Cortana on every chief state); a dead worker is never restarted; a removed companion keeps its worker or its folder is deleted with its ideas; the worker starts without --keep-open and closes after its first turn, or without --run so Orca opens a new Run instead of Master Chief's; a failed start is recorded as running; ark chief state with no companions makes an Orca call or breaks its Red on main, Run leads and Host sections"
status: active
changed_by: 2026-11-14-ARK-480-1
---

## Objective

Prove `ark companions sync` keeps exactly one live Orca worker for each companion of `ark.yml`, stops the worker of a companion that was removed, and prints one line per companion; and that `ark chief state` runs the same sync as its own section and makes no Orca call when no companion is listed. Serves ARK-480/AC2.

## Preconditions

- A temp `ARK_HOME`, project `p` with two companions `alpha` and `beta` (valid entries, instructions files present), and `companions/` is empty.
- A fake orca that keeps state in a file: a Master Chief Run in `run-list`, a live `worker-list` (rows with `dispatchId`, `terminalState`), `worker-start` that returns a receipt (`dispatchId`, `terminal`) and adds a live row, `worker-stop` that removes the row, and a log of every call with its arguments. The fake of `test/fake-orca.ts` answers `worker-list` empty and fails `worker-stop`, so this case extends it or uses a second fake, and the existing `run step` cases keep passing.
- Each fake verb can be set to fail (exit non-zero, or hang past the Orca time limit).

## Steps

1. Run `ark companions sync --project p`. Read stdout, the call log and `companions/alpha/`, `companions/beta/`.
2. Run it again.
3. Mark the live row of `beta` as gone (the worker closed) and run it again.
4. Remove `alpha` from `ark.yml` and run it again. Put a line in `companions/alpha/ideas.md` before this step.
5. Failures, each from a fresh state with both companions listed: (a) no Master Chief Run in `run-list`; (b) `worker-start` fails for `alpha` only; (c) `worker-stop` fails when a removed companion is stopped; (d) every Orca verb fails.
6. Remove both companions from `ark.yml` (no `companions` key) and clear the call log, with no `companions/` folder. Run `ark companions sync --project p` and `ark chief state --project p`.
7. Restore both entries, then run `ark chief state --project p` with live workers for both. Run `bun test test/chief.test.ts`.

## Expected results

- Step 1: stdout has one line for each companion in `ark.yml` order, each saying `started`; the call log has one `worker-start` for each with `--keep-open`, `--run <Master Chief Run id>`, a worktree that is not a run worktree, the entry's harness and model, and a spec that holds the text of its instructions file and the fixed preamble; each `companions/<name>/` holds the record of the dispatch id.
- Step 2: both lines say `running`; the call log has no `worker-start`.
- Step 3: `beta` says `started` and has a new dispatch id; `alpha` says `running`.
- Step 4: a line for `alpha` says `stopped` and the log has one `worker-stop` for its recorded dispatch id; `beta` says `running`; `companions/alpha/ideas.md` still holds its line.
- Step 5: (a) exit 1, `ark: ` line that says there is no Master Chief Run, no `worker-start` call, no record written; (b) exit 1 with an `ark: ` line naming `alpha`, no dispatch id recorded for `alpha` (the next sync starts it again), and `beta` is still handled; (c) exit 1 with an `ark: ` line, and the record of the removed companion is kept so the next sync tries the stop again; (d) exit 1 with an `ark: ` line naming the Orca error, never a line that says `stopped` or `running`.
- Step 6: both commands make no Orca call (empty log), print no companions section, and `chief state` exits 0 with the same sections as before this ticket.
- Step 7: `chief state` prints the sync as its own section with `running` for each companion, and its `Red on main`, `Run leads` and `Host` sections are unchanged; with Orca down, the companions section says `unavailable` and the command exits 0 as for the other live sources. `bun test test/chief.test.ts` exits 0.

## Screenshot checkpoints

None. The surface is CLI output; no screenshot applies.
