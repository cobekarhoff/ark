# Project checks, ticket kinds and how `ark test` proves a ticket

This page covers three things you meet before an MR opens. On GitHub an MR is a pull request.

| You want to                                                  | Read                                                                  |
| ------------------------------------------------------------ | --------------------------------------------------------------------- |
| Run lint, typecheck or a similar command on every run        | [Add project checks](#add-project-checks)                             |
| Know what a `bug`, `perf` or `refactor` ticket needs         | [Ticket kinds](#ticket-kinds)                                         |
| Know what `ark test` runs, and what evidence it leaves       | [What `ark test` runs](#what-ark-test-runs) and [Evidence](#evidence) |
| Know why `ark merge-request open` or `ark run close` refused | [What refuses an MR](#what-refuses-an-mr)                             |

## Add project checks

A check is a command that `ark test <run>` runs in its repo worktree before the suites. Every check runs, `checks` first, then the old-id and plan-membership checks. A check that exits non-zero makes `test.completed` record `passed: false`. `ark test` prints `check <name> failed` and the last 20 lines of its output. The full output is in `<run folder>/results/check-<name>.log`, next to the suite logs. When a check failed, `ark test` stops after the last check: it runs no suite and no base run, and exits 1. `ark test <run> --keep-going` runs the suites anyway. A project with no `checks` runs as before.

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

- `cores`: the CPU cores the check takes from the host's test budget (`test_budget_cores`, default 60% of the host's cores, rounded down; a whole-suite `bun test` outside `ark test` waits for the same budget). A whole number, 1 or more. The default for a check is 1.
- `<cores>`: Ark replaces this in the command of a check, a suite, a suite's `base_command` or its `changed_command` with the number of cores that command took. Use it for a flag such as `--workers=<cores>`.

### Ark's own check that writes

Ark's own `ark.yml` also runs `bun scripts/cli-reference.ts && git diff --exit-code docs/reference/cli.md`, named `cli-reference`. It regenerates `docs/reference/cli.md` and fails when the committed copy was stale. It is the one check that writes a file. Skip it unless your repo generates a doc the same way.

## Run only the affected tests in a quick run

A suite can set `changed_command`, the command that runs the tests a change can reach. It is optional, and each project opts in suite by suite. It must contain `{base}` and `{report}`, or `ark.yml` is refused with `suites[0].changed_command must contain {base}`.

- A `--quick` run of a suite with `changed_command` runs it in place of `command` and of the own-commit `base_files` selection, with `{base}` set to the run's worktree base commit and `{report}` as in `command`. A worktree with no recorded base runs the whole `command`.
- It records the test files that ran in `files` of the suite row in `test.completed`, from the `file` of each test in the report, and prints them on the `suite` line. A reused suite prints them too.
- A changed command that selects no test file prints `suite <name> head  skipped  (no test files are affected)`, never `passed`. A command that exits non-zero, with or without a report, fails the suite.
- A suite with no `changed_command` runs as before: the own-commit files when it has `base_files`, else in full.
- A full `ark test`, with or without `--keep-going`, never reads `changed_command`: it runs the `command` of every suite. `--quick` records `mode: quick`, so `ark merge-request open` still refuses until a full run passes at the head.
- The report of the changed command must name the test file in `file` on each test, or the `files` list is empty. The Bun parser reads Bun's JUnit report and the JUnit report of Jest, Vitest or Playwright; use `parser: bun` for them, as for Playwright.

| Runner | `changed_command`                                                                                                                           | `parser` | Checked                                                             |
| ------ | ------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------------------------------------------------------------------- |
| Bun    | `bun test --changed={base} --reporter=junit --reporter-outfile={report}`                                                                    | `bun`    | Yes, with Bun 1.4.4                                                 |
| Jest   | `JEST_JUNIT_OUTPUT_FILE={report} JEST_JUNIT_ADD_FILE_ATTRIBUTE=true jest --changedSince={base} --passWithNoTests --reporters=jest-junit`    | `bun`    | No: Jest is not installed here. Needs the `jest-junit` package.     |
| Vitest | `vitest run --changed {base} --passWithNoTests --reporter=junit --outputFile={report}`                                                      | `bun`    | No: Vitest is not installed here. Check that the report has `file`. |
| pytest | `changed=$(git diff --name-only --diff-filter=d {base} -- '*.py' \| grep test); pytest -o junit_family=xunit1 --junitxml={report} $changed` | `pytest` | No: pytest is not installed here.                                   |

`--passWithNoTests` keeps Jest and Vitest from exiting 1 when nothing is affected, which would fail the quick run. pytest has no built-in selection: use a plugin such as pytest-testmon or pytest-picked, or the `git diff` pipe above, and write the JUnit report to `{report}` with `junit_family=xunit1` so each test has a `file`. A pytest command that selects no file writes no test case, and the pytest parser then refuses the report: make the command fall back to a cheap test file in that case.

Selection is by the import graph (`bun test --changed`) or by the changed files, so a test that reads a Markdown file, a skill or a config file is not reached by a change to it. A quick run can pass where the full run fails: a quick run is never proof, and the full `ark test` stays the gate before the MR. On a dirty checkout the command also selects the tests that the uncommitted changes reach.

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
- **Census.** A full run first counts the base's own tests on the same checkout, before the head's test files are copied in. A suite with `base_files` runs the run's own test files that exist at base, and any other suite runs whole. The logs go to `<run folder>/results/census/`, and the result is cached by the base commits and the suite command. The census is how `ark test` reports the tests skipped at base and the tests the run deleted (the `tests` and `deleted` lines, and `passed_count`, `skipped`, `base_skipped` and `deleted` in `test.completed`). A full run of `kind: refactor` also keeps the wall time of the census as the pristine duration of each suite, beside the head's: the `suite` line prints `head <seconds>s  pristine base <seconds>s`, `test.completed` `suites[]` holds `head_s` and `pristine_s`, and `results/resources.json` holds `suites[<name>].pristine.wall_s`. The base run still copies the head's test files onto base, so only the census shows what the base's own test files cost. The duration is stored with the cached census, so a rerun reports it; a census that failed or did not run leaves it out and never changes `base_passed` or the exit code.
- **Reuse.** A suite that passed at the same heads, mode and command (head), or at the same base commits, copied test files and command (base), is reused from the project's `test-cache/` and printed `reused`. A failed result runs again, and `checks` run every time.
- **Suite failure.** A suite that fails prints `suite <name> (<level>)  failed`, then `exit code`, its log path `results/<suite>.log` and the last 20 lines of the log, so the cause needs no `cat`. A criterion with `verified_by` prints `no test title starts with <test case id>` on a new line after its `criterion` line for each test case that reads `missing`. A quick run that selected test files for a suite with `changed_command` or `base_files` prints no such line, because a test in another file has no result there.
- **Flaky.** A test file that fails once and passes on retry (through `base_command` with that file) passes the suite and is printed `flaky`. The retro and the MR body list it.
- **Failed files, run first.** `test.completed` records `failed_files` for each suite: the test files that still failed after that one retry, and are neither flaky nor red on main. A full `ark test` first runs the `failed_files` of the run's last `test.completed` (any mode), through the `base_command` of the suite with `{files}`, after compose is up and before any suite, and prints `ark test: failed files of the last test, run first`. A file that still fails stops the run with exit 1 and `the files of the last test still fail: <suite> (<files>); run no other suite`: no other suite, no base run, and the next full run runs the files again. The pre-run adds no result, no evidence and no `resources.json` row. `--keep-going` skips it, and so do `--quick`, a last test that passed, a last test with no `failed_files` (also one written before the field), a suite with no `base_command`, and a suite whose failed test names no file (no retry, so no `failed_files`). A failed file that no longer exists at head is left out, and a suite with no file left runs no command. A failed check stops a run with no suites, so the next full run has no `failed_files` and runs no pre-run.
- **Red on main.** A test file that still fails after its retry, that the run's own commits did not touch (first-parent, no merge commits; a file that came in through `ark worktree sync` is untouched), runs once through `base_command` at the tip of the target branch: `git fetch origin`, then `origin/<target>` in a throwaway `git clone --shared` under `$TMPDIR/ark-tip-*`, made like the base checkout with `setup` and compose, and only when such a file exists. When each test that failed at head also fails there (matched by name), `ark test` prints a line that starts with `red on main` and names the file, `test.completed` lists it in `red_on_main` (not in a quick run), and the file is not a failure: `passed` is true when it is the only one, so it spends no round, opens no escalation gate and does not block `ark merge-request open`. `ark chief state` lists it under `Red on main` with the run id, so Master Chief can write a bug ticket. A file that fails twice at head and once on main counts as red on main. A touched file that fails is never run on main and always fails the run. A file that is not checked (a suite with no `base_command`, a failed test whose report names no file, no `origin`, a failed `git fetch origin`) keeps failing and the output says `not checked on main`. A file that ran at the tip but has a head-failing test that does not fail there (it passes, or the file is gone) counts and prints `not red on main`. A test case tagged in a red on main file still reads `failing`. A reused suite replays its `red on main` line from the cache; the cache key has no main tip, so a file fixed on main shows until the next change.
- **Failed check.** `ark test` runs every check, and a failed check then stops the run: no suite, no base run, and `results/evidence` keeps the files of the last run. `test.completed` records `passed: false`, the failed checks, `suites: []`, the heads, and each criterion as `missing` (`not run` in a quick run), never `failing`. `--keep-going` runs the suites as before, in a full and a quick run. A `bug` run whose new test fails a check needs `--keep-going` for the `failing` criterion that its red proof reads.
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

Before it writes the event, `ark gate record <run> manual <AC id> ok` checks the file as it will be with that line added. A malformed file is refused with `evidence malformed: <AC id>: <reason>`, no event and no file change: fix the file and answer again. The answer also records the head of each repo. `ark merge-request check <run> --stage final` prints `warning: manual answer older than head: <AC id>` when a repo head differs from it later (a clean `ark worktree sync` merge is not a difference), and the exit code stays 0.

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
- A repo head changed since the last test. A clean `ark worktree sync` merge does not change it; a merge that regenerated a `generated` file does, so run `ark test` again.
- A branch does not merge cleanly (`ark merge-request open` only). Ark runs `git fetch origin` and `git merge-tree --write-tree HEAD origin/<target>` in each repo it pushes (a new MR or an open one it refreshes), before any push. The message names the repo and `--merge`, and nothing is pushed for any repo. After the merge step fixes the branch, the same command passes with no new `ark worktree sync`.
- A counted string in an AC is in no tracked file. See below.
- A `not:` string is still in a tracked file. See below.
- The evidence is missing, malformed or stale. See [Evidence refusals](#evidence-refusals).

### See the refusals before open

`ark merge-request check <run> --stage head|step|final [--step <id>] [--summary <text>]` prints each problem of that stage, one line each with the text of the refusal, and exits 1 when there is one. It writes no file, event or ref and never fetches, so the branch-merge check above is not part of it.

- `head`: the counted AC strings, the MR title and the shape of each evidence file that exists, without the last line `human: ok` and the `reviewer:` line. `ark test` runs it at its end and prints a `merge-request check` section only when there is a problem; its exit code does not change.
- `step`: adds `evidence missing` for the non-test ACs of the plan step `--step <id>` (all non-test ACs without it). `ark run step <run> <validator step> finish` runs it for the step's `criteria` and refuses a problem with no event. At a finish a missing demonstration or inspection file, a pending manual answer and the MR title are not problems, and an AC string counts only once every implementer step of that AC has finished.
- `final`: every refusal above in the order of `open`, with the last lines, and the warning above.

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
