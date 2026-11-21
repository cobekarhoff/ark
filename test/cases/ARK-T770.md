---
id: ARK-T770
title: "ARK-T770 the ark test runs of two projects share one core budget from host.yml: a 2-core suite of the second waits while the first holds 2 of 2, and both run together at 4"
level: integration
technique: "boundary values on the host budget (2: the two suites fill it twice over; 4: both fit) with two real ark test processes of two projects"
priority: high
risk: "each project's `ark test` still compares the shared tickets with its own budget (the project default `max(1, floor(0.6 x cores))`), so a suite of a second project starts next to a suite of the first that already fills the host budget (the ticket's case: the project with the higher budget starts a suite the other's budget does not allow); or the host file is not read at all, so the budget does not move from the default"
status: active
changed_by: 2026-11-21-ARK-623-1
---

## Objective

Prove two `ark test` runs of two projects admit their suites against one budget, `test_budget_cores` of `ARK_HOME/host.yml`, when neither `ark.yml` sets a budget.

Gate answers:

1. Protects the shared host budget across projects: one value for every caller of the one ticket folder `ARK_HOME/test-budget`.
2. Fails when a caller passes its own default or a project value to `openTestBudget` in place of the host value: with budget 2 the second suite starts next to the first on a host whose default is 4 or more; with budget 4 the second waits on a host whose default is 3 or less. The two rows together fail on any host size.
3. ARK-T59 proves two runs never run two whole-budget suites together, with one budget of 6 (from `host.yml` after this change, as its `startRun` fixture moves there). On a 10-core host 6 equals the default `max(1, floor(0.6 x 10))`, so ARK-T59 cannot tell `host.yml` from the default. ARK-T155 owns the first-in-first-out order and the clamp inside one budget. This case owns where the budget comes from when two projects meet.
4. No seam beyond the existing ones: two real `ark test` processes of two projects in one temp `ARK_HOME` (the `lock-one` and `lock-two` fixture of `test/test-lock.test.ts`), the suite script's `hold` and `release` files and the suite log. The memory reading is the healthy fake host of `test/tmpdir-preload.ts` (`ARK_FAKE_HOST`), which reaches macOS only, as for ARK-T187: the case skips off macOS.

## Preconditions

- One temp `ARK_HOME` with two projects, `lock-one` and `lock-two`, each with one run. Neither `ark.yml` sets `test_budget_cores`, `test_min_free_memory_percent` or `test_max_swap_gb`. The suite of each run sets `cores: 2`; its command appends `start <run>` and `end <run>` to the shared suite log and blocks between them while the `hold` file exists, until the case writes `release`.
- Healthy fake host and the CPU seam of the preload at 0, so only cores can hold.
- Each row writes `ARK_HOME/host.yml` with only `test_budget_cores` set (2, then 4). The case puts the file back to `test_budget_cores: 6` (the budget of the fixture) when a row ends; no row removes it.

## Steps

1. `host.yml` holds `test_budget_cores: 2`. Create `hold`. Start `ark test` of the `lock-one` run and wait for `start <run one>` in the suite log. Start `ark test` of the `lock-two` run and read its output until a `waiting:` line shows. Read the suite log and the ticket store. Write `release` and wait for both processes to exit.
2. `host.yml` holds `test_budget_cores: 4`. Create `hold`. Start the `lock-one` run and wait for its start; start the `lock-two` run and wait for `start <run two>` in the suite log. Write `release` and wait for both to exit.

## Expected results

- Step 1: the second output has `waiting: place 1 of 1; running: <run one> 2 cores`; while it waits the suite log has no `start <run two>` and the store holds one started ticket of 2 cores and one waiting ticket of 2 cores. After the release both exit 0, the suites of the two runs never overlap (each `start` is followed at once by the `end` of the same suite), and `end <run one>` comes before `start <run two>` in the log (the cores are taken for each suite, so the two runs interleave suite by suite).
- Step 2: `start <run two>` comes before `end <run one>` (both suites run together within 4 cores), and the second output never names `<run one>` as running. Both exit 0.
- No ticket is left in the store after both runs end.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
