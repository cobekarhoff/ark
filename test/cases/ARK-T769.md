---
id: ARK-T769
title: "ARK-T769 ark test of a project with no host key in its ark.yml takes the memory floor and the swap ceiling from host.yml in ARK_HOME"
level: integration
technique: "equivalence classes (host file floor below and above the reading; host file swap ceiling above the reading) at one fixed host reading"
priority: high
risk: "`ark test` keeps the default floor 20 and ceiling 8 or reads them from the project, so the runs of a project with no floor in its ark.yml wait on a host that keeps 15 to 19 percent free (smart-qc on 2026-11-20); or it reads the floor of host.yml and drops its swap ceiling"
status: active
changed_by: 2026-11-21-ARK-623-1
---

## Objective

Prove the memory hold of `ark test` (`openTestBudget` from `executeTest`) uses `test_min_free_memory_percent` and `test_max_swap_gb` of the host file `host.yml` in `ARK_HOME`, for a project whose `ark.yml` sets none of the three host keys.

Gate answers:

1. Protects the source of the memory limits of `ark test`: the host file, not the project and not the defaults when the file sets them.
2. Fails when `executeTest` still passes the defaults or a project value, or reads only one of the two memory keys of the host file.
3. ARK-T187 owns the hold itself (inclusive limits, one line, recovery, an unreadable reading) at the defaults 20 and 8; its `host.yml` sets only `test_budget_cores: 6`, so it sets no memory limit. ARK-T771 owns the same limits for `ark chief state`, a separate reader.
4. No new seam: the reading is the fake host of `test/tmpdir-preload.ts` (`ARK_FAKE_HOST`, written by `setFakeHost` of `test/helpers.ts`), which reaches macOS only, as for ARK-T187. The case skips off macOS.

## Preconditions

- Temp `ARK_HOME` with a project whose `ark.yml` sets none of `test_budget_cores`, `test_min_free_memory_percent` and `test_max_swap_gb`, and a run with one cheap suite whose command writes a marker (the `ark test memory admission` fixture of `test/test-lock.test.ts`).
- No other suite runs in the temp store.
- The fake host reading is written with `setFakeHost` before each row. The CPU seam of the preload stays at 0, so only memory can hold.
- Each row writes `ARK_HOME/host.yml` itself, with `test_budget_cores: 6` (the budget of the fixture) beside the key its step names. The row puts the file back to `test_budget_cores: 6` alone when it ends; no row removes the file.

## Steps

1. `host.yml` holds `test_min_free_memory_percent: 10`. Fake reading: 17 percent free, 2 GB swap. Run the real `ark test <run>` to its end.
2. `host.yml` holds `test_min_free_memory_percent: 20`. Same reading. Run `ark test <run>` in the background; wait for the `waiting for memory` line, then two more host readings (`afterHostReads(2)`); read the output and the suite log. Write a healthy reading and wait for the end.
3. `host.yml` holds `test_max_swap_gb: 12`. Fake reading: 50 percent free, 10 GB swap. Run `ark test <run>` to its end.

## Expected results

- Step 1: the suite starts at once, exit 0, the marker is written, and the output has no `waiting for memory` line and no `memory` word.
- Step 2: while held, exactly one line `ark test: waiting for memory: free 17% is below the 20% floor` and no suite start; after the recovery the suite starts and the run exits 0.
- Step 3: the suite starts at once, exit 0, with no `waiting for memory` line (the default ceiling 8 would hold it).
- The project's `ark.yml` is unchanged by every row and holds none of the three keys.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
