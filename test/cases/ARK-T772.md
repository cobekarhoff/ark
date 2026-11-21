---
id: ARK-T772
title: "ARK-T772 ark status refuses an ark.yml with a host key and names host.yml; ark test refuses a host.yml with an unknown key or a value below the minimum, and uses the defaults with no or an empty host.yml"
level: integration
technique: "equivalence classes (each of the three host keys in ark.yml; an unknown host key; a value that is not an integer; YAML that is not a mapping) and boundary values (each key at its minimum and one below it); empty and missing file"
priority: high
risk: "an ark.yml that still sets a host key loads and its value is silently ignored, or is refused as an unknown key with a wrong `did you mean` and no word of host.yml (the ark project during the cutover); or a typo in host.yml (`test_budget_core`) silently gives the default budget to every project; or a budget of 0 or a negative floor is taken, so no suite ever starts or memory never holds; or the minimum is off by one; or a missing host.yml (CI, a fresh host) stops every `ark test`"
status: active
changed_by: 2026-11-21-ARK-623-1
---

## Objective

Prove the two refusals of AC4 at the commands that make them, and the defaults with no host file:

- `loadConfig` refuses an `ark.yml` that sets `test_budget_cores`, `test_min_free_memory_percent` or `test_max_swap_gb`, with an error that names the key and `host.yml`, shown by `ark status`.
- `ark test` refuses `ARK_HOME/host.yml` with an unknown key (naming the nearest valid key), with a value below the minimum (1 for `test_budget_cores`, 0 for the other two) or not an integer, and with YAML that is not a mapping, naming the file and the key. It starts no suite.
- `ark test` with no `host.yml`, or an empty one, runs with today's defaults.

Gate answers:

1. Protects the config contract of the host keys: where each key may live, the checks of its value and the defaults.
2. Fails when the ark.yml keys stay in `ProjectConfig` or reach the unknown-key path first, when the host reader takes an unknown key or `Number()` of any value, when a check uses `<=` for the minimum, or when a missing or empty file is an error.
3. ARK-T389 owns the unknown keys of ark.yml and their nearest key; the three host keys are not unknown keys but a refusal of its own that names `host.yml`. ARK-T773 owns the readers that print a bad host file and keep working. ARK-T187 owns the memory defaults 20 and 8 with no host file; ARK-T155 step 6 owns the formula of the default budget at fixed core counts.
4. No seam: `ark status` and `ark test` run as real processes against a temp `ARK_HOME`; the budget shows in the `<cores>` placeholder of the suite command.

## Preconditions

- Temp `ARK_HOME` with a valid project (no host key in its `ark.yml`) and a run at the building phase whose one suite has no `cores` and a command that writes its `<cores>` argument and a marker to files.
- The fake host reading of the preload (`ARK_FAKE_HOST`) is healthy with 0 GB swap for the rows that run a suite, so the at-minimum swap ceiling of 0 does not hold; the CPU seam of the preload stays at 0. The rows that run a suite skip off macOS, as ARK-T187 does; the refusal rows run on every host.
- The case writes `ARK_HOME/host.yml` for each row and removes it at the end.

## Steps

1. `ark.yml` of the project with one host key added, one row for each: `test_budget_cores: 6`, `test_min_free_memory_percent: 10`, `test_max_swap_gb: 8`. Run `ark status`.
2. Valid `ark.yml`, `host.yml` with `test_budget_core: 6`. Run `ark test <run>`.
3. `host.yml`, one row each: `test_budget_cores: 0`, `test_min_free_memory_percent: -1`, `test_max_swap_gb: -1`, `test_budget_cores: 2.5`. Run `ark test <run>`.
4. `host.yml` holding a YAML list (`- 1`). Run `ark test <run>`.
5. `host.yml` with each key at its minimum: `test_budget_cores: 1`, `test_min_free_memory_percent: 0`, `test_max_swap_gb: 0`. Run `ark test <run>` to its end.
6. No `host.yml` in `ARK_HOME`, then an empty `host.yml`. Run `ark test <run>` to its end each time. The case computes the default budget as `max(1, floor(0.6 x os.cpus().length))`.

## Expected results

- Step 1: each row prints `config error: <project>: ` with the path of its `ark.yml`, the key and `host.yml` in the message, and no `did you mean`; `ark status` exits 1 with `1 project config(s) invalid`.
- Step 2: exit 1; the error names the path of `host.yml`, `test_budget_core` and `did you mean test_budget_cores?`.
- Step 3: each row exits 1 with an error that names the path of `host.yml` and the key.
- Step 4: exit 1 with an error that names the path of `host.yml`.
- Steps 2 to 4: no suite marker, no ticket in `ARK_HOME/test-budget`, and no `test.completed` event in the run.
- Step 5: exit 0, the suite ran with `<cores>` 1.
- Step 6: both runs exit 0 and the suite ran with `<cores>` equal to the default budget; no error names `host.yml`, and no `host.yml` is created.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
