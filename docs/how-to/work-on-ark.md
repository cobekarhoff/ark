# Work on Ark

For a person or an agent that changes Ark's own code. [`AGENTS.md`](../../AGENTS.md) holds the short rules; this page holds the commands and the test conventions. [`CONTEXT.md`](../../CONTEXT.md) defines the words.

## Install

Ark needs Bun 1.4.4 (the version of every CI job). On a Mac:

```sh
bun install --frozen-lockfile
bunx playwright install chromium
```

CI runs the second command with `--with-deps`, which also installs system packages on Linux. `bun test` starts Playwright from some tests, so install the browser before the first run.

## The four checks

```sh
bun run format        # writes: run it yourself before you commit
bun run format:check
bun run typecheck
bun run lint
```

`format` writes; the other three only check. `.githooks/pre-commit` and CI never run `format`: a file you forgot to format fails there. The order to run them in is in [`AGENTS.md`](../../AGENTS.md).

[`.githooks/pre-commit`](../../.githooks/pre-commit) runs `typecheck`, `lint`, `format:check` and `bun test --parallel`. CI runs the same checks, with the Bun suite in 4 shards and a serial `hub-timing` job ([below](#how-ci-shards-the-bun-suite)), and `bunx playwright test`. The hook, `bun run test` and the `cli` suite of `ark.yml` still run every file with `--parallel`.

The hook is opt-in. Turn it on once per clone:

```sh
git config core.hooksPath .githooks
```

The hook runs the full Bun suite, not only the files you changed. On a busy host that is slow, and it waits for the test budget when the budget is full ([below](#a-whole-suite-bun-test-waits-for-the-test-budget)).

## How CI shards the Bun suite

Every pull request, and every push to `main`, runs the full suite: there is no fast lane and no path filter. CI has these jobs:

- `checks` runs `typecheck`, `lint` and `format:check`.
- `bun-shards` is a matrix of 4 jobs. Shard `N` runs `bun test --parallel --shard=N/4 --timings=test/timings.json`, which is one quarter of the `*.test.ts` files except the four hub timing files (one `--path-ignore-patterns=test/<file>` each, plus `--path-ignore-patterns=test/pw/**`, because a command line ignore flag replaces the `pathIgnorePatterns` list of `bunfig.toml`). A new test file runs in exactly one shard with no edit to the workflow, and a file that is not in the timings file still runs in exactly one shard.
- `hub-timing` is a matrix of 2 serial entries that run `bun test` with no `--parallel` and no `--shard`: `./test/hub-stall.test.ts` alone, and `./test/hub-idle.test.ts ./test/hub-home-lag.test.ts ./test/hub-stall-window.test.ts` in one process. `--parallel` workers on a 4-core runner starve hub-stall's 120 s soak, hub-home-lag's 1,620-run fixture and hub-idle's call counts. If you rename or delete one of the four files, change the `hub-timing` entries and the `--path-ignore-patterns` flags of `bun-shards` in the same commit.
- `playwright` runs `bunx playwright test` on 4 workers (`playwright.config.ts` sets 4 when `CI` is set, 2 otherwise).
- `test` is the required status check of `main`. It needs `checks`, `bun-shards` and `hub-timing`, always runs, and fails unless all three succeeded, so a failed, cancelled or skipped shard or hub timing entry fails it. A matrix job cannot be named `test`: it would report `test (1)` to `test (4)`.

`test/timings.json` is the shard balance and nothing else: Bun reads the recorded milliseconds of each file to give the 4 shards about equal total time (the four hub timing files are not in a shard, so their entries do not count), and to start the slowest files first. It does not select, skip or order what must pass. A stale or missing entry makes a shard slower, never a file unrun.

The recorded milliseconds are from the Linux CI run 44464183048 (the per-test times summed for each file); a file added since has the median. Refresh it from CI when the suite changes much: a Mac gives times that do not match the runner. In a CI job, run the command below unsharded, download the file it writes, run `bun run format` and commit it. For a local refresh, run the same command. It must run unsharded, because `--update-timings` under `--shard` replaces the file with that shard's files only:

```sh
bun test --parallel --update-timings --timings=test/timings.json
bun run format
```

`format` is needed: `format:check` also checks the JSON file that Bun writes.

## Run one file

```sh
bun test test/<file>.test.ts                 # one Bun test file
bunx playwright test test/pw/<file>.pw.ts    # one browser spec
```

`bun test` never runs a spec: `bunfig.toml` ignores `test/pw/**`, and `playwright.config.ts` takes only `test/pw/**/*.pw.ts`. `bun test --parallel` is the `test` script of `package.json`. A run of one file never waits for the test budget.

`bun test --rerun-each=N <one file>` is the quick repeat of a flaky test, in place of N separate processes. The preload of `test/tmpdir-preload.ts` removes the temp root (`bun-test-*`) and the fake host root after repeat N, so every repeat finds them. A removal that throws EFAULT or EBUSY is retried 3 times (4 calls in all); ENOENT counts as removed. If it still fails, or fails with another code, the preload prints one stderr line, `ark preload: could not remove <root>: <code>`, leaves the root for `scripts/temp-cleaner.sh` and keeps the exit status of the tests. Two opt-in variables, read by the preload only, test this: `ARK_PRELOAD_RM_FAULTS=<N|all>` makes the first N (or every) `rmSync` call of the `bun-test-*` root throw EFAULT, and `ARK_PRELOAD_RM_LOG=<file>` appends the root to the file before every `rmSync` call of either root. Set them only in the environment of one inner `bun test`, never in the outer process. It supports one file in one process: no `--parallel`, no several files. A one-file run takes no cores from the test budget; a whole-suite `--rerun-each` waits like any bare `bun test`. One process keeps module state and process-level timing between repeats, so 20 separate `bun test` processes beside the loaded suite stay the proof of a race or load fix.

## A whole-suite `bun test` waits for the test budget

A whole-suite `bun test` waits for the shared test budget. It prints one line that it waits for the test budget, and it starts its files when the cores are free.

Why: a whole suite outside the budget raises the host load for every run's `ark test`. At a high load their timing tests fail, and they pass alone.

- A whole suite is `bun test`, `bun test --parallel` or `bun test <directory>`, for example `bun test test --parallel=3`. It asks `N` cores for `--parallel=N`, the CPU count for a bare `--parallel`, and 1 core with no flag. It never asks for more than `test_budget_cores` of the host file `host.yml`.
- It takes the cores through `openTestBudget` in `cli/test-lock.ts`, the same budget as `ark test`. `ark chief state` lists it as `bun test` under `## ark test budget`.
- It never waits when it runs one or more test files (`bun test test/<file>.test.ts`): that run takes no cores, so a whole suite that one of its tests starts waits like a bare run. It never waits when `ark test` started it, or when a held bare run started it: both set `ARK_TEST_BUDGET=<pid>` on the commands they start, and the wait is skipped only while that pid is alive and holds a started ticket. Any other value, such as a hand-set `held`, waits.
- It never waits when it finds no project for the folder, no readable `ark.yml` or no `ps`. CI and `.githooks/pre-commit` have no project, so they never wait.
- It reads the budget from the host file `host.yml` in ARK_HOME (`~/.ark/host.yml` by default; keys in the [reference](../reference/cli.md#hostyml-fields)), the same file as `ark test`. A missing file gives the defaults. A bad file never refuses the run: the hook uses the defaults.
- The project is `ARK_PROJECT`, else the project whose `workspace` or run folder holds the folder you run in.
- With `--parallel`, a terminal shows the waiting line at once. Without a terminal, Bun shows the line of a worker only when the worker's first file ends.
- A `bun test --parallel` worker whose coordinator ended exits within 10 s: `test/tmpdir-preload.ts` starts a thread (`test/parent-watch.ts`) that kills the worker when its parent pid changes. `scripts/temp-cleaner.sh` stops one that is left anyway.

The wait lives in the preload of `bunfig.toml`, which calls `holdTestBudget()` from `cli/bare-test-budget.ts`. It covers this repo. Another Ark project gets the wait when its own `bunfig.toml` preload calls the same function.

## Generated reference

`docs/reference/cli.md` is generated: `scripts/cli-reference.ts` builds it from `bun cli/ark.ts <words> --help`, so the text comes from the command descriptions in `cli/commands/*.ts`.

```sh
bun scripts/cli-reference.ts
```

The generator rewrites only the text between `<!-- generated:commands:start -->` and `<!-- generated:commands:end -->`. A hand edit of that text fails the check named `cli-reference` and `ARK-302-AC10`; see [Ark's own check that writes](project-checks.md#arks-own-check-that-writes).

## `ark test --quick` and `ark test`

`ark test <run>` takes a run, so it works only inside a run. `--quick` runs at head only, with no base run, and, in each suite that `paths` selects, the tests that the suite's `changed_command` selects with the run's base commit, else only the changed test files of the run's own commits (a suite with `base_files`), else the whole suite. It prints the files a `changed_command` ran. It records `mode: quick` and is never a gate: a full `ark test <run>` never runs `changed_command`. See [Run only the affected tests in a quick run](project-checks.md#run-only-the-affected-tests-in-a-quick-run). `ark merge-request open` refuses unless the last test at head is a full `ark test <run>`, with one exception: a run with no code file may open its MR on a passing quick test, and CI's full suite is then the proof (see [a quick test as the gate](project-checks.md#a-quick-test-as-the-gate-for-a-run-with-no-code-file)). `ark run close <run> handed_off` and a project with `merge_requests: none` still need the full test. The line `mode: quick (not a gate: ...)` that `ark test --quick` prints is not the verdict for such a run: `ark merge-request open` and `ark merge-request check <run> --stage final` are. Markdown-reading tests that no import graph reaches (`test/playbooks.test.ts`, `test/pr-writing.test.ts`, `test/worker-start.test.ts`, `test/pr-writing-skill.test.ts`, `test/retro.test.ts`, `test/strategy.test.ts`, `test/plan.test.ts`) run in CI only on such a run; `bun run format:check` is the only local gate on Markdown layout. A failed check (`format:check`, `typecheck`, `lint`, old-id, plan membership) stops either run after the last check, with no suite and exit 1; `--keep-going` runs the suites anyway. A full `ark test <run>` first runs the files that failed in the run's last test (`failed_files` in `test.completed`, through the `base_command` of the suite with `{files}`) and stops with exit 1 when one still fails; `--keep-going` skips that pre-run, and a suite with no `base_command`, or whose failed test names no file, gets none. See [`ark test`](../reference/cli.md#test). Outside a run, use the commands above.

## Tests

- A test starts its title with its test case id, for example `ARK-T704 ...`. A test case is the file `test/cases/<id>.md`, made by `ark test-case new <KEY>` (in a git repo, or with `--run <run>`).
- A UI test calls `checkpoint(page, "<name>")` from `test/pw/helpers.ts` before each assertion, so the screenshot exists when the assertion fails. It writes only when `ARK_EVIDENCE_DIR` is set, as `ark test` does.
- A test that builds a git origin names its branch: `git init --initial-branch=main`, then push `HEAD:refs/heads/main`. The default branch comes from `init.defaultBranch`: `main` on a host that sets it, `master` on the Linux CI runner, so a fixture that relies on the default can pass here and fail in CI.
- A test of a time limit sets `ARK_TEST_LIMIT_MS` (test-only, read at each call by `limitOr` in `test/helpers.ts`) to the limit of the git, ark and hub calls of the stall, and sets and restores it in `try/finally` around the stall alone. Unset, `tempGitRepo` and the `ark` of `test/worktree-submodule.test.ts` keep 45 s (`commandLimitMs`), `test/worker-start.test.ts` keeps 25 s (`processLimitMs`), and `startHub` has no limit.
- A hub spec reads the time through the frozen clock of `test/pw/helpers.ts`: `useCleanup()` freezes it, and `testNow`, `isoAt`, `dateOf` and `isoAgo` follow it. A spec never calls `new Date(` or `Date.now()` (`test/wallclock.test.ts` fails it). A test of a view that defaults to the current week or day dates its fixtures from the clock, never a literal date. A test that compares a clock text uses fixed offsets, or a range that crosses midnight on purpose.
- A UI test of an overlay or a list checks that the element is hit at its centre, with `document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)` (example: `test/pw/hub.pw.ts`), not only `toBeVisible()`: an overflow ancestor can clip it.
- A test with fake tools that are stale waits until each source has its first read before it asserts the chip text: `staleRow` in `test/pw/hub.pw.ts` only reads the row, and the wait is in the test (example: `ARK-T315`). Run it once with `bunx playwright test --workers=4 --repeat-each=4` before you finish: Linux CI fails where a Mac passes.
- A test of a view that picks one of several files (sessions, rounds, versions) uses an owner with at least two files and an anchor in the second.
- A change to the header of the hub keeps `.top` wrapping (`hub/page/styles.css`), so the project chips do not clip on Linux CI.

The test gate is [`rules/test-audit.md`](../../rules/test-audit.md): what a test protects, what regression fails it, and whether another test already owns the contract.
