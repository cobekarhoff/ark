---
id: ARK-T685
title: ARK-T685 bun test with no matching Ark project, an unreadable ark.yml, no ARK_HOME or a failing ps runs at once and never fails the suite
level: integration
technique: error guessing and equivalence classes (no ARK_HOME, no project for the folder, invalid ark.yml, no test_budget_cores, ps failure)
priority: high
risk: The preload throws or waits when it cannot find a project, read its config or read its own command line (`ps` fails), so CI (`bun test --parallel`, no ARK_HOME), the opt-in pre-commit hook and a fresh clone fail or hang on every bun test; or a run with no `test_budget_cores` waits on a wrong budget
status: active
changed_by: 2026-11-15-ARK-513-1
---

## Objective

Prove the budget wait never refuses a `bun test`: whenever the preload cannot find a project, read its config or read its command line, a whole-suite run starts at once and exits as the suite itself does.

Expected: no wait, no waiting line, and the exit code of the suite.

## Preconditions

- The scratch repo of ARK-T683 (repo preload, marker-writing test files `a`, `b` and `c` under `test/`, and the `gate` file, which in these rows has no pipe and so ends at once) as a fake suite: every row expects `ran-a`, `ran-b`, `ran-c` and `ran-gate` to exist once.
- The built environment of ARK-T683 for every child: the environment of the case minus the `ark test` marker, `BUN_TEST_WORKER_ID`, `JEST_WORKER_ID`, `ARK_PROJECT` and `ARK_HOME`; each step then sets only what it names. A step that unsets `ARK_HOME` also sets `HOME` to an empty temp folder, so the fallback `~/.ark` (`cli/paths.ts`) is a folder with no project and no ticket, as in CI and on a fresh clone, never the real home of the host.
- A real holder process that holds all 3 cores of a project `demo` in a temp `ARK_HOME`. The scratch repo is the `workspace` of `demo` in every row except step 2 (the `elsewhere` row), where it is neither the `workspace` nor under `runs/`. A row is a state of `ARK_HOME` and cwd; each row runs `bun test --parallel=3` unless the step says otherwise.
- No sleeps: events only.

## Steps

1. Run with `ARK_HOME` unset, `HOME` an empty temp folder and no `ARK_PROJECT`.
2. Run with `ARK_HOME` set to a folder that has project `demo` while the scratch repo is not its `workspace` and not under its `runs/` (no match), with the holder holding all cores.
3. Run with `ARK_HOME` set and the project's `ark.yml` empty, then with invalid YAML, then with `test_budget_cores: 0`. The scratch repo is the `workspace` of the project in each.
4. Run with `ARK_PROJECT` naming a project that does not exist.
5. Run `bun test` (serial, 1 core) with a project that matches and has no `test_budget_cores`, with no holder: the budget is the default of the host, never 0.
6. Run with a project that matches, `test_budget_cores: 3` and the holder holding all 3 cores, with a `ps` shim first on the PATH of the child: once a `ps` that prints nothing and exits 1, once a `ps` that prints nothing and exits 0. The hook calls `ps` by name through PATH (as `readHost` calls `sysctl`), so the shim reaches it.
7. In one row of steps 1 to 4 make a test file fail.

## Expected results

- Steps 1 to 4: all files ran at once, exit 0, no waiting line, no ticket written; step 1 creates no `.ark` folder under the empty `HOME`.
- Step 5: the run starts at once and exits 0, with no waiting line (default budget at least 1, not 0).
- Step 6: with the holder still holding every core, all files ran at once with no waiting line and exit 0: a run whose command line cannot be read does not wait and does not fail.
- Step 7: the exit code is the failing suite's, 1, and the failure text of the test shows: the hook adds no failure of its own.

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
