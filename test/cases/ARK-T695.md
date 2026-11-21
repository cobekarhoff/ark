---
id: ARK-T695
title: "ARK-T695 a whole-suite bun test started outside ark test waits on CPU use over 90 percent while a suite runs, ignores the 1-minute load, starts when nothing runs, and prints one CPU line"
level: integration
technique: "equivalence classes (a suite running or not; CPU above the limit or below it with a high load) on the bare-run admission, state transition (waiting on CPU, running)"
priority: high
risk: "A whole-suite `bun test` run by hand on a busy host starts its files into CPU use of 95 percent because `holdTestBudget` does not reach the CPU hold; or it still reads the 1-minute load, so a host at 5 percent CPU and a load of 30 holds it; or, with nothing running, its owner ticket does not take the idle exception and it waits for ever; or the CPU wait is printed for every file of a `--parallel` run; or a run inside `ark test` or a file run waits on the CPU as well, and so deadlocks on its own reading"
status: active
changed_by: 2026-11-21-ARK-623-1
---

## Objective

Prove a whole-suite bare `bun test` (`cli/bare-test-budget.ts`) is held by the same CPU rule as `ark test`: while another suite runs and CPU use is above 90 percent no file runs and exactly one CPU line shows; at 5 percent CPU with a load of 30 it runs; with nothing running it runs at CPU 99.

Gate answers:

1. Protects the bare path of AC1 and AC2 ("held by the same rule") and the exemptions of ARK-T684 (file argument, `ark test` child, nested run) on the CPU rule.
2. A regression that fails it: `holdTestBudget` bypasses the CPU hold, still reads the load, or the owner ticket of a bare run is not handled by the idle exception; the CPU line prints once for each worker.
3. ARK-T683 and ARK-T684 prove the bare wait on cores only; ARK-T709 and ARK-T710 prove the rule through `ark test`. Neither reaches the bare entry, which is a separate call site of `openTestBudget` with an `owner` ticket for the coordinator.
4. No hook beyond the seams of ARK-T710: the child is a real `bun test` with the preload of the scratch repo, and `ARK_FAKE_CPU_PERCENT` and `ARK_FAKE_LOAD_ONE` are in its built environment. The preload of this repo sets only `ARK_FAKE_CPU_PERCENT`, with `??=` and only after `holdTestBudget()` has run (or not at all), so the value the case sets is the one the hold reads.

## Preconditions

- The fixture and the built environment of ARK-T683: temp `ARK_HOME` whose `host.yml` sets `test_budget_cores: 3`, project `demo`, scratch git repo with the repo's `bunfig.toml` preload and marker-writing test files `a`, `b` and `c`, and no marker of `ark test`. The built environment keeps or sets `ARK_FAKE_CPU_PERCENT` and `ARK_FAKE_LOAD_ONE` (numbers) as the step says.
- Fresh state per scenario. Each scenario below (steps 1, 2, 3, 4 and 5) starts from its own temp `ARK_HOME`, scratch repo, marker directory and holder, with no `ran-*` marker and no earlier result: an earlier scenario cannot supply a marker or a cached result (ARK-T163).
- A holder as in ARK-T683, but it holds 1 of the 3 cores, so the cores of `--parallel=2` still fit and only the CPU hold can wait.
- No sleeps: events only (the ticket file, an output line, a marker file, exit).

## Steps

1. Fresh state. Holder running. `ARK_FAKE_CPU_PERCENT=95`, `ARK_FAKE_LOAD_ONE=0`. Start `bun test --parallel=2` in the scratch repo, cwd the project `workspace`, on a terminal of its own (a `--parallel` worker opens `/dev/tty`, so the CPU line shows live; with only a pipe the output reaches the case when the first file ends, and the ticket alone cannot tell the case that the hold was read, so a release right after the ticket could come before the hold). Wait until the CPU line shows (the hold was read). Check that no `ran-*` marker exists and the child is alive; read the ticket and `ark chief state`. Then release the holder (nothing runs, readings unchanged), wait for exit, and read the whole terminal output.
2. Fresh state. Holder running, same readings. Start serial `bun test` (no flag); read its output until the waiting line shows; check that no `ran-*` marker exists; stop it through its PID.
3. Fresh state. Holder running. `ARK_FAKE_CPU_PERCENT=5`, `ARK_FAKE_LOAD_ONE=30`. Start `bun test --parallel=2`. Wait for exit; read the output and the markers.
4. Fresh state. No holder (nothing runs). `ARK_FAKE_CPU_PERCENT=99`, `ARK_FAKE_LOAD_ONE=30`. Start `bun test --parallel=2`. Wait for exit.
5. Fresh state. Holder running, `ARK_FAKE_CPU_PERCENT=95`: run `bun test test/a.test.ts` (a file argument), and `bun test test --parallel=2` with the marker of `ark test` (copy the name from `run()` in `cli/test-run.ts`).

## Expected results

- Step 1: while held: no `ran-*` marker; one waiting ticket with label `bun test`; `ark chief state` lists it as `waiting: bun test (pid N)`. After the release: the child exits 0, every `ran-*` marker exists, and the output of that invocation holds exactly one line that contains `waiting for CPU` (not one for each of the two workers or each file) and no `waiting for memory` line.
- Step 2: exactly one output line that contains `waiting for CPU` and names `95` and the limit `90`; the bare caller wraps it, so the line starts `bun test: ` (the case does not assert the text before `waiting for CPU`); no `waiting for memory` line; no `1-minute load`; no marker.
- Step 3: all files run (every `ran-*` marker), the child exits 0, and the whole output holds no `waiting for` line.
- Step 4: all files run and the child exits 0 with no `waiting for` line: the owner ticket takes the idle exception.
- Step 5: both start at once with no waiting line (the exemptions of ARK-T684 hold for the CPU as well).

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
