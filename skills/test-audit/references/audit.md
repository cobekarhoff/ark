# How to audit tests

Credit: adapted into Ark words from OpenClaw's test-audit skill, <https://github.com/openclaw/openclaw/blob/main/.agents/skills/test-audit/SKILL.md>. MIT License, Copyright 2026 OpenClaw Foundation.

One audit covers one lane: a suite, a folder or a contract area. Write the result as a ledger. You edit no test and no product file.

## 1. Know the project

Read `$ARK_HOME/projects/<project>/ark.yml`. For each suite note its `name`, `level`, `repo`, `command`, `parser` and `base_files`. For each check note its `name` and `command`. Read `test_case_source`: `local` means the test cases are files `test/cases/<KEY>-T<n>.md` in the repo, and a test links to its case by the case id at the start of its title.

## 2. Inventory

For each suite with `parser: bun` (this includes a Playwright suite whose `parser` is `bun`):

```sh
ark test-audit inventory --project <name> --summary
ark test-audit inventory --project <name> --json
```

`--project` is required, and `ARK_PROJECT` is ignored. The command changes no file. It reads the `workspace` checkout of `ark.yml`, not the run's worktree, and takes `last` from the newest report of any run of the project: use it on a run only when that checkout is on the run's branch. Each row has `file`, `line`, `title`, `kind`, `id`, `acs` and `last`. `kind` is `case` (a test case id in the title), `old` (an old AC id such as `ARK-12-AC3`) or `none`. A `test.each` table is one row marked `[table xN]`; a skipped or `only` declaration carries its modifier. `--changed <base>` lists only the declarations that the diff from `<base>` to HEAD changes, and prints `old id touched:` for each one with an old AC id. A deleted file has no declaration, so `--changed` never lists a deleted test.

### A suite that is not `parser: bun`

The inventory prints a `skip:` line on stderr for such a suite and lists none of its tests. Make the lane inventory by hand, from the suite's own `command` in `ark.yml` with the runner's list mode, so that no test runs:

- `pytest`: the `command` with `--collect-only -q` added.
- `behave`: the `command` with `--dry-run` added.
- Any other runner: its documented list or dry-run flag. When it has none, read the test files.

Write one ledger row for each test or scenario the list shows. Take the test case id from the title marker the parser uses (`case` for `pytest`, `@case:<id>` for `behave`). Take the time from `results/<suite>.report` (below). Say in the ledger that the lane was inventoried by hand.

## 3. Time

`ark test` prints no time for a test file. Two sources have it:

- `results/<suite>.report` in the run folder: JUnit, one time for each test case. It is the run's own report.
- `ark test-audit inventory --project <name> --json`, column `durationMs`: the time of the newest `<suite>.report` of any run of the project, one row for each declaration, joined to the report by file and title. It is the project's time, not necessarily this run's.

The time of a file is the sum of the times of its rows. `durationMs` is null (`last` is `-`) when no report matches: a new file, a renamed title, or no `ark test` yet. Write `time unknown` for it; never guess. Report each file over 5 s. A file over 30 s needs a named contract that no cheaper level proves, or a cut.

Slow is a cost, not a defect. Before you cut a slow test, ask whether a cheaper level proves the same contract. If none does, keep it.

## 4. Mark each test

| Mark | Meaning                                                                                            | Test case action                                  |
| ---- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| R    | Keep as it is. It protects a contract that no other test owns, and its name is true.               | `reuse`                                           |
| F    | Keep and fix: rename, merge a copy into it, widen a table, or move the proof to the real boundary. | `update`                                          |
| C    | Delete. Another test, the keeper, proves the same contract at the same or a stronger boundary.     | `retire`, with the keeper's case id in the reason |
| D    | Delete. It protects no contract: it is one of the junk patterns below.                             | `retire`, with the reason                         |

One contract has one keeper. When two tests protect one contract, keep the one at the strongest boundary that is practical, and mark the other `C`.

## 5. Junk patterns

A test is junk, and a candidate for `D`, when it has one of these. Quote the line as evidence.

- no assertion
- a self-comparison
- an expected value that the code under test made
- a copied inventory: an export list, or a table of names copied from the source
- a source or wording grep
- a call-shape assertion that repeats a boundary proof
- a test-only export or seam: an export, flag, wrapper or hook with no production caller
- a mock that supplies the behaviour the test asserts
- a fixture that fakes what the owner should produce: ordering, receipts, persistence
- a negative control that fails on another guard than the one it names
- a name that the assertions do not exercise

A test with a junk pattern that still guards a real contract is `F`, not `D`: move the proof to the real boundary.

## 6. Retention bar

Never mark `D` or `C` for any of these reasons alone: the test is slow, the test is static, or the test looks old.

A test stays (`R` or `F`) when it protects a public API, protocol, config, migration, storage, security, default, ordering or release contract.

A test that is red on the baseline may be a product bug. Mark it `R`, say `baseline red`, and give it to the human as a bug. The audit never deletes a red test and never fixes the product.

## 7. Write the ledger

One row for each declaration, as a Markdown table, with these columns: `file`, `line`, `title`, `contract` (what it protects, in a few words), `owner` (the production file the contract lives in), `time` (summed for the file, or `unknown`), `mark` (R, F, C, D), `keeper` (a test case id or `file:line`, for `C` only) and `evidence` (the line that shows the junk pattern, or the reason it stays). A file with more than one mark gets one row for each test.

Count the rows against the inventory: every declaration has a row, and a row has exactly one mark. A ledger with a missing row is not a ledger.
