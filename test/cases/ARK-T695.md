---
id: ARK-T695
title: "ARK-T695 a whole-suite bun test started outside ark test waits on the load of test_max_load, prints one load line, runs no file while it waits, and starts at the limit"
level: integration
technique: "boundary values (a configured limit below and above the core-count default, a load between them; the default with the key absent) on the bare-run admission, state transition (waiting on load, running)"
priority: high
risk: "A whole-suite `bun test` run by hand on a loaded host (the host the ticket targets) starts its files into a load of 20 to 63, because `holdTestBudget` passes no load limit to `openTestBudget`; or it ignores `test_max_load` of `ark.yml` and uses the core-count default (so a configured limit above the default still holds, or one below it still admits); or the load wait is printed for every file of a `--parallel` run; or a run inside `ark test` or a file run waits on the load as well, and so deadlocks on its own load"
status: active
changed_by: 2026-11-18-ARK-515-1
---

## Objective

Prove a whole-suite bare `bun test` (`cli/bare-test-budget.ts`) is held by the same load rule as `ark test`: no file runs while the load is above `test_max_load` of the project's `ark.yml`, exactly one `waiting for load` line shows, and the files run when the load is at or under the configured limit, whether that limit is below or above the core-count default.

Gate answers:
1. Protects the bare path of AC1 ("held by the same rule") and the exemptions of ARK-T684 (file argument, `ark test` child, nested run) on the load rule.
2. A regression that fails it: `holdTestBudget` omits `maximumLoad` (the bare run ignores the load, or the key and falls back to the core count), or the load line prints once for each worker.
3. ARK-T683 and ARK-T684 prove the bare wait on cores only; ARK-T692 proves the rule through `ark test`. Neither reaches the bare entry, which is a separate call site of `openTestBudget`.
4. No hook beyond the seam of ARK-T692: the child is a real `bun test` with the preload of the scratch repo, and `ARK_FAKE_LOAD_ONE` is in its built environment. The preload of this repo sets `ARK_FAKE_LOAD_ONE` to `0` with `??=` only after `holdTestBudget()` has run, so the value the case sets is the one the hold reads.

## Preconditions

- The fixture and the built environment of ARK-T683: temp `ARK_HOME`, project `demo`, scratch git repo with the repo's `bunfig.toml` preload and marker-writing test files `a`, `b` and `c`; no holder, the budget is free. The built environment keeps or sets `ARK_FAKE_LOAD_ONE` (a number) and no marker of `ark test`.
- `C` is `os.availableParallelism()` of the host, read by the case. `ark.yml` of `demo` sets `test_max_load` as the step says: `C/2` (below the default) or `2*C` (above it). Every load used lies between the configured limit and the default, so omitting the project value changes the outcome on any host with `C >= 1`.
- No sleeps: events only (the ticket file, an output line, a marker file, exit).

## Steps

1. `test_max_load: C/2`; `ARK_FAKE_LOAD_ONE=0.75*C` (above the limit, under the default `C`: a bare run that ignores the key admits). Start `bun test --parallel=3` in the scratch repo, cwd the project `workspace`, as a detached child with no terminal. A `--parallel` run's output reaches the pipe when its first file ends, so wait until the run's ticket exists in the store (its waiting point). Check that no `ran-*` marker exists and the child is alive; read the ticket and `ark chief state`.
2. Stop the child through its PID. Start serial `bun test` (no flag) with the same limit and load; read its output until the waiting line shows; check that no `ran-*` marker exists; stop it.
3. `test_max_load: 2*C`; `ARK_FAKE_LOAD_ONE=1.5*C` (above the default `C`, under the limit: a bare run that ignores the key holds). Start `bun test --parallel=3`. Wait for exit; read the output and the markers.
4. Remove `test_max_load` from `ark.yml`. Load `C` runs; load `C + 0.1` holds as in step 1 (stop it).
5. With `test_max_load: C/2` and the load `0.75*C` (above the limit), run `bun test test/a.test.ts` (a file argument), and `bun test test --parallel=3` with the marker of `ark test` (copy the name from `run()` in `cli/test-run.ts`).

## Expected results

- Step 1: no `ran-*` marker; one waiting ticket with label `bun test`; `ark chief state` lists it as `waiting: bun test (pid N)`.
- Step 2: exactly one output line that contains `waiting for load` and names the load `0.75*C` and the limit `C/2`; the bare caller wraps it, so the line starts `bun test: ` (the case does not require the prefix to be removed and does not assert the text before `waiting for load`); no `waiting for memory` line; no marker.
- Step 3: all files run (every `ran-*` marker), the child exits 0, and the whole output holds no `waiting for load` line.
- Step 4: the default is the core count: `C` runs and `C + 0.1` holds, with the load line naming the limit `C`. The project value is read by the bare run, not only the default: step 1 held and step 3 ran on the same host where the default would give the opposite result.
- Step 5: both start at once with no waiting line (the exemptions of ARK-T684 hold for the load as well).

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
