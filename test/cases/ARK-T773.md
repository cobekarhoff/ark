---
id: ARK-T773
title: "ARK-T773 with a bad host.yml, ark status and ark chief state print the host file error and keep working with the defaults, and a bare whole-suite bun test never fails and waits on the default budget"
level: integration
technique: "equivalence classes (the three readers that do not refuse; an unknown key and a value below the minimum as the bad file) and state transition for the bare run (waiting on the default budget, released)"
priority: high
risk: "one typo in the host-wide file stops `ark status` and `ark chief state` for every project, so Master Chief cannot see the runs or the Host section it needs to find the typo; or they say nothing of it; or they keep the valid keys of a bad file, so the hold differs from what `ark test` refuses; or the bare `bun test` preload throws on it and fails every suite and the pre-commit hook, or skips the budget and starts on cores the `ark test` runs hold"
status: active
changed_by: 2026-11-21-ARK-623-1
---

## Objective

Prove that only `ark test` refuses a bad `ARK_HOME/host.yml` (ARK-T772). `ark status` and `ark chief state` print the same error as `ark test` and keep their whole output and exit code, and `ark chief state` holds with the defaults. The bare `bun test` preload never refuses: it uses the default budget.

Gate answers:

1. Protects the non-refusing readers of the host file: what they print and that they still work on a bad file.
2. Fails when `status` or `chiefState` throws on the host file (exit 1, no runs, no Host section), prints no error or another text than `ark test`, takes the valid keys of a bad file, or when the preload throws (the suite fails) or returns before its wait (no ticket, files run while the cores are held).
3. ARK-T772 owns the refusal by `ark test` and the checks of each value; ARK-T188 owns the Host section on a good host; ARK-T685 owns the preload on a missing project or config. None reads a bad host file in these three readers.
4. No seam beyond the existing ones: real `ark status`, `ark chief state` (fake host of ARK-T188, `ARK_FAKE_CPU_PERCENT` and `ARK_FAKE_LOAD`, macOS only) and a real bare `bun test` with the fixture, built environment and holder of ARK-T683.

## Preconditions

- Temp `ARK_HOME` with a valid project (no host key in its `ark.yml`) and an open run.
- Two bad host files, one per row: `A`, `test_min_free_memory_percent: 10` and `test_budget_core: 6` (an unknown key next to a valid one); `B`, `test_budget_cores: 0`.
- For each bad file the case first runs `ark test <run>` and keeps its error line (ARK-T772 proves that it refuses).
- For step 3: the scratch repo, preload and marker-writing files of ARK-T683, in the `workspace` of a project `demo` in the same `ARK_HOME`; a holder that holds `D` cores, the default budget `max(1, floor(0.6 x os.cpus().length))` that the case computes.

## Steps

1. With each bad file, run `ark status`.
2. With each bad file, fake reading 17 percent free and 2 GB swap, CPU 10 percent: run `ark chief state --project <project>`.
3. With file `A`: the holder holds `D` of `D` cores. Start a bare `bun test` (serial) in the scratch repo and read its output until the waiting line shows; check no `ran-*` marker. Release the holder and wait for the exit.

## Expected results

- Step 1: the output has the error line of `ark test` for that file once and the line of the open run; exit 0.
- Step 2: the output has the same error line once, and the `## Open runs` and `## Host` sections; the `hold new runs:` line is `hold new runs: free 17% is below the 20% floor` (the default floor, not the 10 of file `A`); exit 0.
- Step 3: one waiting line for the budget while the holder holds every default core and no file runs; one waiting ticket with label `bun test` asking 1 core. After the release every file runs once and the run exits 0; no line of the output fails the run.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
