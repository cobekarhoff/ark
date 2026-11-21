---
id: ARK-T771
title: "ARK-T771 ark chief state of two projects prints the same hold new runs line for one host reading, from the floor and the swap ceiling of host.yml"
level: integration
technique: "equivalence classes (host file limits that hold none, host file limits that hold on both reasons) read through two projects at one fixed host reading"
priority: high
risk: "the run-start hold of `ark chief state` keeps the defaults 20 and 8 or a project value, so Master Chief holds new runs of one project and starts runs of another on the same host (smart-qc on 2026-11-20: `free 17% is below the 20% floor` while the ark project saw no hold); or it names a default in the reason in place of the host file value"
status: active
changed_by: 2026-11-21-ARK-623-1
---

## Objective

Prove `holdReasons` of `ark chief state` (`cli/chief.ts`) takes the free memory floor and the swap ceiling from `ARK_HOME/host.yml`, so the `hold new runs:` line is the same for every project at one host reading.

Gate answers:

1. Protects the source of the run-start hold limits and their equality across projects.
2. Fails when `chiefState` still passes the defaults or a project's value to `holdReasons`: step 1 would hold on `free 15% is below the 20% floor`, and step 2 would name 20 and 8 in place of 16 and 9.
3. ARK-T188 owns the Host section, the order of the reasons and the default limits with no host file; ARK-T365 and ARK-T366 own the CPU reason. None sets a host file or compares two projects. ARK-T769 owns the same keys for `ark test`, a separate reader.
4. No new seam: the fake host of `test/tmpdir-preload.ts` (`ARK_FAKE_HOST`, macOS only, the case skips off macOS), `ARK_FAKE_CPU_PERCENT` and `ARK_FAKE_LOAD` as in ARK-T365, through the real `ark chief state --project <name>`.

## Preconditions

- One temp `ARK_HOME` with two projects, `lock-one` and `lock-two` (the fixture of `test/test-lock.test.ts`); neither `ark.yml` sets any of the three host keys. No test ticket, no live Orca.
- `ARK_FAKE_CPU_PERCENT=10` and `ARK_FAKE_LOAD=2`, so CPU never adds a reason; free disk as in ARK-T365.
- The case writes `ARK_HOME/host.yml` for each row and removes it at the end.

## Steps

1. `host.yml` holds `test_min_free_memory_percent: 10` and `test_max_swap_gb: 12`. Fake reading: 15 percent free, 10 GB swap. Run `ark chief state --project lock-one` and `ark chief state --project lock-two`; read the `hold new runs:` lines of each `## Host` section.
2. `host.yml` holds `test_min_free_memory_percent: 16` and `test_max_swap_gb: 9`. Same reading. Run both again.

## Expected results

- Step 1: each output has exactly one `hold new runs:` line, and both are `hold new runs: no`.
- Step 2: each output has exactly one `hold new runs:` line, and both are `hold new runs: free 15% is below the 16% floor; swap 10.0 GB is above the 9 GB ceiling`.
- Both commands exit 0 in each step.

## Screenshot checkpoints

None. The surface is CLI output; no screenshot applies.
