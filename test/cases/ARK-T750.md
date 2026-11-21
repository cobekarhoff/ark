---
id: ARK-T750
title: ARK-T750 merge-request open still refuses a quick last test when the own diff of any repo holds a code file, the plan adds, updates or retires a case, a check or the quick suite failed, a manual AC has no ok, or plan.yml is missing, with one refusal text per row
level: integration
technique: "equivalence classes and decision table: one row for each reason a quick result is not enough, each row the accepted head of ARK-T748 with one change"
priority: high
risk: "the no-code rule accepts a quick result for a diff that holds code: a `.ts`, a script, `package.json`, a Markdown fixture or eval input in a test or data folder (`test/fixtures/`, `skills/pr-writing/evals/`), a generated `docs/reference/cli.md`, a `.ts` renamed to `.md` (`git diff --name-only` lists only the new path), or a second repo with a `.ts` (only the first repo read); or it reads a plan `add`, `update`, `retire` or old-shape empty action as reuse; or the no-code path skips the `passed` or the manual-ok rule along with the criteria rule; or a missing `plan.yml` throws a stack trace instead of a refusal"
status: active
changed_by: 2026-11-20-ARK-604-1
---

## Objective

Prove that each condition of the no-code path is checked: with one condition broken and every other rule of `checkStage` (stage `final`) met, `ark merge-request open <run>` exits 1, pushes nothing and prints the refusal of that row. Serves ARK-604/AC2.

Authoring gate:

1. Protects: the narrow edge of the no-code exception: a quick result opens the MR only for a run whose every repo's own diff holds only hand-written Markdown outside a test or data folder (a folder named `test`, `tests`, `__tests__`, `fixtures`, `__fixtures__`, `__snapshots__`, `testdata` or `evals`), whose plan has only `reuse` cases, and whose quick run and checks passed.
2. Fails when: any single condition of the eligibility helper is removed or weakened (each row names the one it catches; rows 4 and 16 catch a data folder dropped from the folder list), or the no-code path skips the `passed` or manual rule.
3. Existing proof misses it: ARK-T121 and ARK-T738 refuse a quick result on a diff of test files under the old rule, where no exception exists; they do not show which condition of the new rule refuses. ARK-T748 owns the accepted head; this case is its negative table. Each row starts from that accepted head, so the row turns green only when its own condition is deleted (learning of ARK-463, ARK-T374), never through an unrelated guard. Extend the ARK-T748 fixture with a row parameter; do not copy its setup.
4. No test-only export, flag or hook: the real `ark` process, a real `ark test <run> --quick` for each row (rows 11 and 12 need its real failure), and the fake forge. Row 12's switch file is read by `FAKE-T2` in `test/other.test.ts`, a test of the fixture's suite, which fails while the file exists; no check of `ark.yml` and no product code reads it. Row 12 has no failing check, so it never copies row 11 (a `checks` command, as in ARK-T665, `test/test-run.test.ts`).

## Preconditions

- Fixture A of ARK-T748 (feature run, `test_cases` one `reuse` entry, own commit of `docs/guide.md` and `skills/demo/SKILL.md`, `generated` lists `docs/reference/cli.md`), with one change per row below. Each row is a fresh run.
- Rows 1 to 6 and row 16 add a second own commit that adds the named path (row 6 renames `src/old.ts` to `docs/old.md`), and the own Markdown commit stays; rows 7 to 10 change only `plan.yml`; rows 11 to 14 change the named item; row 15 adds one own commit to repo two of ARK-T748 fixture F.
- Q is the text ``the last test at this head is quick, not a gate: run `ark test <run>` ``, with the row's run id.

| Row | One change from the accepted head                                                                                                                                        | Refusal (first line of stderr)             |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------ |
| 1   | adds `src/a.ts`                                                                                                                                                          | Q                                          |
| 2   | adds the script `scripts/release.sh`                                                                                                                                     | Q                                          |
| 3   | changes `package.json`                                                                                                                                                   | Q                                          |
| 4   | adds the Markdown fixture `test/fixtures/lint/fail.md`                                                                                                                   | Q                                          |
| 5   | changes the generated `docs/reference/cli.md`                                                                                                                            | Q                                          |
| 6   | `git mv src/old.ts docs/old.md` of a `.ts` that the base holds                                                                                                           | Q                                          |
| 7   | the plan case action is `add`                                                                                                                                            | Q                                          |
| 8   | the plan case action is `update`                                                                                                                                         | Q                                          |
| 9   | the plan case action is `retire`                                                                                                                                         | Q                                          |
| 10  | the plan case action is `""` (old plan shape)                                                                                                                            | Q                                          |
| 11  | a check of `ark.yml` exits 1 (the quick run records `passed: false`)                                                                                                     | `the last test run did not pass`           |
| 12  | the suite has no `base_files`; the base also holds `test/other.test.ts` with a test `FAKE-T2 other` that no AC's `verified_by` names, and it fails through a switch file | `the last test run did not pass`           |
| 13  | the ticket has a second AC with `method: demonstration` and `manual: true`, and no `manual ok`                                                                           | `manual criterion without ok: <the AC id>` |
| 14  | `plan.yml` is removed after the quick run                                                                                                                                | Q                                          |
| 15  | ARK-T748 fixture F (two repos, a worktree in each) with one own commit of `src/b.ts` in repo two; the quick run passes in both                                           | Q                                          |
| 16  | adds the Markdown eval input `skills/pr-writing/evals/pr-200.md`                                                                                                         | Q                                          |

Row 12 keeps the Markdown-only diff: a failing test file in the own commit would be code and refuse for that reason instead. Its suite has no `base_files` and no `changed_command`, so the quick run runs the whole suite (`cli/test-run.ts`, the quick selection of a suite). `FAKE-T1` passes, so `FAKE-1/AC1` reads `not run` as on the accepted head (`quickStatus` turns passing into `not run`), and only `FAKE-T2` fails, so the suite result is the one difference. A failing `FAKE-T1` would record AC1 `failing` and refuse first on `criteria not passing in the last test run`, a guard the no-code path keeps. `FAKE-T2` fails while its switch file exists; the file sits in a temporary folder outside the repo, so creating it changes no head.

Row 12 control: a fresh run of row 12's fixture with the switch off. Its quick run passes, and `ark merge-request check <run> --stage final` accepts it, so the row's head is an accepted head and deleting the `passed` rule on the no-code path turns row 12 green. The control is a fresh run, not a second quick run of row 12, because the suite cache can replay a result of the same heads and mode.

## Steps

1. For each row: build the run, run `ark test <run> --quick` and read its exit code and the last `test.completed`.
2. Run `ark merge-request open <run>`. Read the exit code, stderr, the `merge_request.opened` events and the remote refs (`git ls-remote origin`).
3. For row 14, also run `ark merge-request check <run> --stage final` and read the exit code and output.
4. Row 12 control: build the run with the switch off, run `ark test <run> --quick`, then `ark merge-request check <run> --stage final`. Read both exit codes and the last `test.completed`.

## Expected results

- Step 1: rows 1 to 10, 13, 14, 15 and 16 record `mode: "quick"` and `passed: true`; rows 11 and 12 record `mode: "quick"` and `passed: false`. Row 12 also records no `checks` entry with `passed: false` and a suite row with `passed: false` (a failed check stops the run with `suites: []`, so a row 12 built like row 11 fails here).
- Step 2, every row: exit 1; the first line of stderr starts with `ark: ` and then the row's refusal of the table (rows 11 and 12: ``ark: the last test run did not pass: fix the failures and run `ark test` again``); no `merge_request.opened` event; no `ark/` branch on the origin; no `gh pr create` call.
- Step 3: exit 1 and the problem line is Q; the output holds no stack trace (no `at ` frame and no `Error:` from `loadPlan`).
- Step 4: the quick run exits 0 and records `mode: "quick"`, `passed: true` and `FAKE-1/AC1` `not run`; the check exits 0 with no problem line.

## Screenshot checkpoints

none: CLI and event-log case; no UI surface.
