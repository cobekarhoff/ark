# Add project checks to ark.yml

A check is a command that `ark test <run>` runs in its repo worktree before the suites. A check that exits non-zero makes `test.completed` record `passed: false`. `ark test` prints `check <name> failed` and the last 20 lines of its output. The full output is in `<run folder>/results/check-<name>.log`, next to the suite logs. A project with no `checks` runs as before.

`checks:` is a list of `{ name, repo, command }`. `repo` must be a repo of the workspace. A check must not write files, so `format` is not a check: use `format:check`.

Add this block to `~/.ark/projects/ark/ark.yml`. Ark runs do not edit `ark.yml`:

```yaml
checks:
  - name: format:check
    repo: .
    command: bun run format:check
  - name: typecheck
    repo: .
    command: bun run typecheck
  - name: lint
    repo: .
    command: bun run lint
  - name: cli-reference
    repo: .
    command: bun scripts/cli-reference.ts && git diff --exit-code docs/reference/cli.md
```

`cli-reference` regenerates `docs/reference/cli.md` and fails when the file differs from the committed one.

## What else refuses

- `ark merge-request open <run>` refuses when a non-manual AC is not `passing` in the last `test.completed`.
- It refuses when a counted string in backticks in the text of an AC is in no tracked file at HEAD of any repo of the workspace, run worktree or not. A backtick span must sit on one line and be non-blank. Each is searched with `git grep -F`; a string also passes when it names a tracked file or folder at HEAD (`git cat-file -e HEAD:<path>`, with one trailing `/` dropped, so `scripts/check.py` and `docs/old/` pass when they exist). A string that is empty after the drop, such as `/`, never passes.
- These strings are not counted, because no file holds them: a string with a placeholder (`<` followed later by `>`, or a lone `<`), a `*`, the three dots `...`, or a suffix `:<digits>` or `:<digits>-<digits>` (a `file:line` reference); a string that holds the id of its own AC, written with `-` or `_` (a test name or command of that AC); and every string of a manual AC.
- A string that starts with `not:` is a removed string. The text after `not:` must be in no tracked file of any repo at HEAD and name no tracked file or folder there, else the command refuses with `AC string still in a tracked file at head:`, the AC and the string without the prefix. `not:` alone is no string. `git grep -F` matches a substring, so a stale path inside a longer path that stays is still found: write that one outside backticks, as you do a string that the run rewrites or that only describes the old state.
- Fix the text of an AC of a run with `ark criteria amend`.
- `ark run close <run> handed_off` applies the same refusals, and those of the `kind` rules below, before it appends `run.closed` or removes a worktree. On a refusal run `ark test <run>` again or `ark criteria amend`.
- A ticket may set `kind: bug`, `perf`, `refactor` or `feature` (default `feature`). `bug`: `ark run step <run> <implementer step> start` refuses until a failing `ark test` of every AC exists. `perf`: `results/baseline.md` and `results/compare.md` must exist and not be empty. `refactor`: the suites must pass at the base commit. `ark test` runs them there on every run, records `base_passed` and exits 1 when they fail.
- Both commands also refuse missing, malformed or stale evidence. See Evidence below.

## Evidence

`ark test <run>` runs the suites twice, on every run and for every `kind`: at head on the run's workspace, and at base on a throwaway checkout of each touched repo at its `worktree.created` commit. Before the base run it copies the head's version of each file that the diff adds or changes under a `test`, `tests` or `features` folder, at any depth, into the base checkout, so a new test meets the base build. A deleted file stays at base, and production files are never copied. A failure at base is data: a new test fails there, and `ark test` still exits 0. A failure at head fails `ark test`. A `refactor` run also needs its suites to pass at base. The base run is never reused.

The base logs stay in `<run folder>/results/base-<suite>.log`. The evidence goes to the run folder:

```text
results/evidence/<test case id>/base/result.json
results/evidence/<test case id>/base/command.log
results/evidence/<test case id>/base/screenshots/<checkpoint name>.png
results/evidence/<test case id>/head/...
results/evidence/<AC id>.md
```

- `result.json` holds `case`, `name` (the JUnit name), `status` (`passed`, `failed` or `skipped`) and `sha`, the commit of the checkout that ran, and `repo`, the repo that ran it. A case carried by several suites keeps the failed result of any of them and the command output of all of them. A case that one run reports and the other does not gets a `failed` result and the suite's `command.log` on the missing side: a new test file that crashes at base, or a test file the run deleted (it stays at base, so the head has no result). `ark test` removes the folder of a case that no longer appears.
- `command.log` has the suite command on its first line, then the whole output of the suite for that checkout, and `exit <code>` on its last line. Every case of one suite shares the same `command.log`.
- `ARK_EVIDENCE_DIR` is set for each suite run to a scratch folder. In a Playwright test, `checkpoint(page, "<name>")` from `test/pw/helpers.ts` writes `screenshots/<name>.png` under it, under one subfolder for each test case id in the test's title. Call it before the assertion of that step, so the screenshot exists when the assertion fails at base. It writes nothing when the variable is not set. `ark test` moves each subfolder to the `screenshots/` folder of its case and drops the screenshots of a test with no case id. The setting `screenshot: "only-on-failure"` in `playwright.config.ts` is separate and stays.
- A non-test AC (`demonstration`, `inspection` or `analysis`; an old `manual: true` AC reads as `demonstration`) has one file `results/evidence/<AC id>.md`, where `<AC id>` is the local id such as `AC6`:
  - `demonstration`: the sections What the human did, What the human saw, Before and After (each with a screenshot path, checked for shape, not for existence), and the last line `human: ok`. `ark gate record <run> manual <AC id> ok` appends that line once; a `problem` answer appends nothing, and the other methods keep their file as written.
  - `inspection`: the sections Files (each `path:start-end`), Checked against and Verdict, with the line `reviewer: pass` or `reviewer: fail`.
  - `analysis`: the sections Command, Output, Threshold and Result, each given for Base and for Head.
- `ark merge-request open` and `ark run close <run> handed_off` check the evidence last, before any push and before any event, and name every AC and case that fails, after `refused: evidence is not complete`:
  - `evidence missing: <AC id> (<method>)` when a non-test AC has no file.
  - `evidence malformed: <AC id>: <reason>` when the file lacks a section of its method or a required value, and the reason names it.
  - `test evidence missing: <AC id> <test case id> (<base|head>)` when a case in the `verified_by` of a `test` AC has no `base/` or no `head/` folder.
  - `test evidence stale: <AC id> <test case id>` when the `sha` in its `head` `result.json` is not the current head of the repo named in that `result.json`. Run `ark test <run>` again after the last commit.
  - An AC with no `verified_by` needs no test evidence.

## Literals

The ACs of ARK-302, ARK-304 and ARK-305 name these strings. `ark merge-request open` finds each one in this file, as the rule above requires:

- `ark.yml`
- `checks:`
- `{ name, repo, command }`
- `ark test <run>`
- `test.completed`
- `passed: false`
- `check <name> failed`
- `checks`
- `test/test-run.test.ts`
- `ARK-302-AC1`
- `bun test test/test-run.test.ts -t ARK-302-AC1`
- `ark merge-request open <run>`
- `manual: true`
- `passing`
- `test/merge-request.test.ts`
- `ARK-302-AC2`
- `bun test test/merge-request.test.ts -t ARK-302-AC2`
- `ARK-302-AC3`
- `bun test test/merge-request.test.ts -t ARK-302-AC3`
- `kind: bug`
- `perf`
- `refactor`
- `feature`
- `kind`
- `ark run start`
- `run.started`
- `ark status <run>`
- `test/run.test.ts`
- `ARK-302-AC4`
- `bun test test/run.test.ts -t ARK-302-AC4`
- `ark plan check`
- `ark run step <run> <implementer step> start`
- `failing`
- `bug run: record a failing ark test of the ACs before the fix`
- `test/plan.test.ts`
- `ARK-302-AC5`
- `bun test -t ARK-302-AC5`
- `kind: perf`
- `results/baseline.md`
- `results/compare.md`
- `ark merge-request open`
- `ARK-302-AC6`
- `bun test -t ARK-302-AC6`
- `kind: refactor`
- `worktree.created`
- `base_passed`
- `ARK-T12`
- `bun test test/test-run.test.ts -t ARK-T12`
- `run-lead.md`
- `brainstorm.md`
- `chief.md`
- `test/playbooks.test.ts`
- `ARK-302-AC8`
- `bun test test/playbooks.test.ts -t ARK-302-AC8`
- `docs/`
- `format:check`
- `typecheck`
- `lint`
- `cli-reference`
- `docs/reference/cli.md`
- `bun scripts/cli-reference.ts`
- `bun test`
- `bun run typecheck`
- `bun run lint`
- `bun run format:check`
- `Enforced by: <check or refusal>`
- `ARK-304-AC1`
- `bun test test/run.test.ts -t ARK-304-AC1`
- `ARK-304-AC2`
- `bun test test/run.test.ts -t ARK-304-AC2`
- `ARK-304-AC3`
- `bun test test/run.test.ts -t ARK-304-AC3`
- `ARK-304-AC4`
- `bun test test/run.test.ts -t ARK-304-AC4`
- `ARK-304-AC5`
- `bun test test/run.test.ts -t ARK-304-AC5`
- `the last test must have passed`
- `ARK-304-AC6`
- `bun test test/playbooks.test.ts -t ARK-304-AC6`
- `--limit <n>`
- `--cursor <cursor>`
- `test/chief.test.ts`
- `ARK-306-AC1`
- `bun test test/chief.test.ts -t ARK-306-AC1`
- `cli/orca-release.ts`
- `ARK-306-AC2`
- `bun test test/chief.test.ts -t ARK-306-AC2`
- `unavailable: orca orchestration run-list failed: <reason>`
- `timed out after <n> s`
- `unavailable: no Orca Run "Master Chief: <project> tickets"`
- `ARK-306-AC3`
- `orca: runtime is not running`
- `bun test test/chief.test.ts -t ARK-306-AC3`
- `ARK-306-AC4`
- `bun test test/playbooks.test.ts -t ARK-306-AC4`
- `test/fixtures/merge-request/sqc-1-criteria.md`
- `SQC-1`
- `SQC-1-AC2`
- `SQC-1-AC6`
- `docs/00-master-reference.md`
- `docs/architecture/`
- `docs/references/`
- `docs/workflows/`
- `docs/operations/`
- `docs/templates/`
- `(N docs)`
- `## Finding the knowledge base`
- `uv run check-knowledge-docs`
- `Paths are relative to the workspace root`
- `ARK_305_AC1`
- `bun test test/merge-request.test.ts -t ARK-305-AC1`
- `bun test test/merge-request.test.ts -t ARK-305-AC2`
- `bun test test/merge-request.test.ts -t ARK-305-AC3`
- `bun test test/playbooks.test.ts -t ARK-305-AC4`
