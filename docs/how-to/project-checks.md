# Project checks, ticket kinds and how `ark test` proves a ticket

This page covers three things you meet before an MR opens. On GitHub an MR is a pull request.

| You want to                                                  | Read                                                                  |
| ------------------------------------------------------------ | --------------------------------------------------------------------- |
| Run lint, typecheck or a similar command on every run        | [Add project checks](#add-project-checks)                             |
| Know what a `bug`, `perf` or `refactor` ticket needs         | [Ticket kinds](#ticket-kinds)                                         |
| Know what `ark test` runs, and what evidence it leaves       | [What `ark test` runs](#what-ark-test-runs) and [Evidence](#evidence) |
| Know why `ark merge-request open` or `ark run close` refused | [What refuses an MR](#what-refuses-an-mr)                             |

## Add project checks

A check is a command that `ark test <run>` runs in its repo worktree before the suites. A check that exits non-zero makes `test.completed` record `passed: false`. `ark test` prints `check <name> failed` and the last 20 lines of its output. The full output is in `<run folder>/results/check-<name>.log`, next to the suite logs. A project with no `checks` runs as before.

`checks:` is a list of `{ name, repo, command }`. `repo` must be a repo of the workspace, such as `.` for a single-repo project. A check must not write files, so a formatter is not a check: use its check mode.

Add a block like this to `~/.ark/projects/<project>/ark.yml`. Ark runs do not edit `ark.yml`:

```yaml
checks:
  - name: lint
    repo: .
    command: "<your lint command>"
  - name: typecheck
    repo: .
    command: "<your typecheck command>"
```

A check may use two more things:

- `cores`: the CPU cores the check takes from the host's test budget (`test_budget_cores`, default 60% of the host's cores, rounded down). A whole number, 1 or more. The default for a check is 1.
- `<cores>`: Ark replaces this in the command of a check, a suite or a suite's `base_command` with the number of cores that command took. Use it for a flag such as `--workers=<cores>`.

### Ark's own check that writes

Ark's own `ark.yml` also runs `bun scripts/cli-reference.ts && git diff --exit-code docs/reference/cli.md`, named `cli-reference`. It regenerates `docs/reference/cli.md` and fails when the committed copy was stale. It is the one check that writes a file. Skip it unless your repo generates a doc the same way.

## Ticket kinds

A ticket may set `kind` to `feature`, `bug`, `perf` or `refactor`. The default is `feature`. A kind changes what must exist before the run goes on.

| Kind       | What it requires                                                                                                                                            | Where it refuses                                                       |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `feature`  | Nothing more.                                                                                                                                               |                                                                        |
| `bug`      | A failing `ark test` of every AC exists before the fix.                                                                                                     | `ark run step <run> <implementer step> start`                          |
| `perf`     | `results/baseline.md` and `results/compare.md` exist and are not empty.                                                                                     | `ark merge-request open`, `ark run close <run> handed_off`             |
| `refactor` | The suites pass at the base commit, when the ticket has a `test` AC. `ark test` runs them there on every run, records `base_passed` and exits 1 on failure. | `ark test`, `ark merge-request open`, `ark run close <run> handed_off` |

## What `ark test` runs

`ark test <run>` runs the suites twice, on every run and for every kind. A failure at base is data: a new test fails there, and `ark test` still exits 0. A failure at head fails `ark test`.

- **Head run.** The suites run on the run's workspace.
- **Base run.** The suites run again on a throwaway checkout of each touched repo at its `worktree.created` commit. The checkout is a `git clone --shared` under `$TMPDIR/ark-base-*`, not a git worktree, so a killed `ark test` leaves no detached worktree in the repo or in Orca. Before the base run, Ark copies the head's version of each file that the diff adds or changes under a `test`, `tests` or `features` folder, at any depth, into that checkout, so a new test meets the base build. A deleted file stays at base, and production files are never copied.
- **Census.** A full run first counts the base's own tests on the same checkout, before the head's test files are copied in. A suite with `base_files` runs the run's own test files that exist at base, and any other suite runs whole. The logs go to `<run folder>/results/census/`, and the result is cached by the base commits and the suite command. The census is how `ark test` reports the tests skipped at base and the tests the run deleted (the `tests` and `deleted` lines, and `passed_count`, `skipped`, `base_skipped` and `deleted` in `test.completed`).
- **Reuse.** A suite that passed at the same heads, mode and command (head), or at the same base commits, copied test files and command (base), is reused from the project's `test-cache/` and printed `reused`. A failed result runs again, and `checks` run every time.
- **Flaky.** A test file that fails once and passes on retry (through `base_command` with that file) passes the suite and is printed `flaky`. The retro and the MR body list it.
- **Red on main.** A test file that still fails after its retry, that the run's own commits did not touch (first-parent, no merge commits; a file that came in through `ark worktree sync` is untouched), runs once through `base_command` at the tip of the target branch: `git fetch origin`, then `origin/<target>` in a throwaway `git clone --shared` under `$TMPDIR/ark-tip-*`, made like the base checkout with `setup` and compose, and only when such a file exists. When each test that failed at head also fails there (matched by name), `ark test` prints a line that starts with `red on main` and names the file, `test.completed` lists it in `red_on_main` (not in a quick run), and the file is not a failure: `passed` is true when it is the only one, so it spends no round, opens no escalation gate and does not block `ark merge-request open`. `ark chief state` lists it under `Red on main` with the run id, so Master Chief can write a bug ticket. A file that fails twice at head and once on main counts as red on main. A touched file that fails is never run on main and always fails the run. A file that is not checked (a suite with no `base_command`, a failed test whose report names no file, no `origin`, a failed `git fetch origin`) keeps failing and the output says `not checked on main`. A file that ran at the tip but has a head-failing test that does not fail there (it passes, or the file is gone) counts and prints `not red on main`. A test case tagged in a red on main file still reads `failing`. A reused suite replays its `red on main` line from the cache; the cache key has no main tip, so a file fixed on main shows until the next change.
- **Runner.** `ark test` runs in a detached runner that holds the host lock and survives a lost connection. `ark test <run> --wait` prints its output and exits with its code, and `ark test <run> --stop` stops it and every suite process.

## Evidence

The base logs stay in `<run folder>/results/base-<suite>.log`. The evidence goes to the run folder:

```text
results/evidence/<test case id>/base/result.json
results/evidence/<test case id>/base/command.log
results/evidence/<test case id>/base/screenshots/<checkpoint name>.png
results/evidence/<test case id>/head/...
results/evidence/<AC id>.md
```

- `result.json` holds `case`, `name` (the JUnit name), `status` (`passed`, `failed` or `skipped`), `sha` (the commit of the checkout that ran) and `repo` (the repo that ran it).
- A case carried by several suites keeps the failed result of any of them and the command output of all of them.
- A case that one run reports and the other does not gets a `failed` result and the suite's `command.log` on the missing side. This happens for a new test file that crashes at base, and for a test file the run deleted (it stays at base, so the head has no result). `ark test` removes the folder of a case that no longer appears.
- `command.log` has the suite command on its first line, then the whole output of the suite for that checkout, and `exit <code>` on its last line. Every case of one suite shares the same `command.log`.
- `ARK_EVIDENCE_DIR` is set for each suite run to a scratch folder. In a Playwright test, `checkpoint(page, "<name>")` from `test/pw/helpers.ts` writes `screenshots/<name>.png` under it, under one subfolder for each test case id in the test's title. Call it before the assertion of that step, so the screenshot exists when the assertion fails at base. It writes nothing when the variable is not set. `ark test` moves each subfolder to the `screenshots/` folder of its case and drops the screenshots of a test with no case id. The setting `screenshot: "only-on-failure"` in `playwright.config.ts` is separate and stays.

### Evidence of a non-test AC

A non-test AC has the method `demonstration`, `inspection` or `analysis`. An old `manual: true` AC reads as `demonstration`. It has one file `results/evidence/<AC id>.md`, where `<AC id>` is the local id such as `AC6`:

| Method          | Sections the file needs                                                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `demonstration` | What the human did, What the human saw, Before and After (each with a screenshot path, checked for shape, not for existence), and the last line `human: ok`. |
| `inspection`    | Files (each `path:start-end`), Checked against and Verdict, with the line `reviewer: pass` or `reviewer: fail`.                                              |
| `analysis`      | Command, Output, Threshold and Result, each given for Base and for Head.                                                                                     |

`ark gate record <run> manual <AC id> ok` appends the line `human: ok` once to a `demonstration` file. A `problem` answer appends nothing, and the other methods keep their file as written.

### Evidence refusals

`ark merge-request open` and `ark run close <run> handed_off` check the evidence last, before any push and before any event. They name every AC and case that fails, after `refused: evidence is not complete`:

- `evidence missing: <AC id> (<method>)`: a non-test AC has no file.
- `evidence malformed: <AC id>: <reason>`: the file lacks a section of its method or a required value. The reason names it.
- `test evidence missing: <AC id> <test case id> (<base|head>)`: a case in the `verified_by` of a `test` AC has no `base/` or no `head/` folder.
- `test evidence stale: <AC id> <test case id>`: the `sha` in its `head` `result.json` is not the current head of the repo named in that `result.json`. Run `ark test <run>` again after the last commit.

An AC with no `verified_by` needs no test evidence.

## What refuses an MR

`ark merge-request open <run>` refuses in these cases. `ark run close <run> handed_off` applies the same refusals, except the clean-merge check, before it appends `run.closed` or removes a worktree. On a refusal, run `ark test <run>` again or fix the AC text with `ark criteria amend`.

- A non-manual AC is not `passing` in the last `test.completed`.
- A manual AC has no `ok` answer.
- A repo head changed since the last test.
- A branch does not merge cleanly (`ark merge-request open` only). Ark runs `git fetch origin` and `git merge-tree --write-tree HEAD origin/<target>` in each repo it pushes (a new MR or an open one it refreshes), before any push. The message names the repo and `--merge`, and nothing is pushed for any repo. After the merge step fixes the branch, the same command passes with no new `ark worktree sync`.
- A counted string in an AC is in no tracked file. See below.
- A `not:` string is still in a tracked file. See below.
- The evidence is missing, malformed or stale. See [Evidence refusals](#evidence-refusals).

### Counted strings in an AC

A string in backticks in the text of an AC must be in a tracked file at HEAD of some repo of the workspace, run worktree or not.

- A backtick span must sit on one line and be non-blank.
- Each string is searched with `git grep -F`.
- A string also passes when it names a tracked file or folder at HEAD (`git cat-file -e HEAD:<path>`, with one trailing `/` dropped), so `scripts/check.py` and `docs/old/` pass when they exist. A string that is empty after the drop, such as `/`, never passes.

These strings are not counted, because no file holds them:

- a string with a placeholder (`<` followed later by `>`, or a lone `<`), a `*`, the three dots `...`, or a suffix `:<digits>` or `:<digits>-<digits>` (a `file:line` reference),
- a string that holds the id of its own AC, written with `-` or `_` (a test name or command of that AC),
- every string of a manual AC.

### Removed strings in an AC

A string that starts with `not:` is a removed string. The text after `not:` must be in no tracked file of any repo at HEAD and name no tracked file or folder there. Otherwise the command refuses with `AC string still in a tracked file at head:`, the AC and the string without the prefix. `not:` alone is no string.

`git grep -F` matches a substring, so a stale path inside a longer path that stays is still found. Write that one outside backticks, as you do a string that the run rewrites or that only describes the old state.
