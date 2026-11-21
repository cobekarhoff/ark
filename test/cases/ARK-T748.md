---
id: ARK-T748
title: ARK-T748 merge-request open accepts a passing quick ark test for a run whose own diff holds only hand-written Markdown and whose plan has only reuse cases, and the MR body says the full suite is CI's
level: integration
technique: equivalence classes of an eligible run (feature with reuse cases, empty test_cases, refactor kind, after a clean sync, a workspace repo with no worktree, a repo with a worktree and no own commit), each reaching the final stage through open and through merge-request check
priority: high
risk: "the no-code path is added on the mode line only, so the same open still refuses on `criteria not passing in the last test run` (a quick run records the test AC `not run`), on `test evidence missing` (a quick run writes no evidence) or, for a refactor run, on `base_passed`; or the own diff is read from the first base and not from the synced commit, so a clean sync that brings a target `.ts` makes the run code; or a workspace repo that has no worktree in the run (no base, no own commit) is read as a failed diff and refuses every no-code run of a multi-repo workspace; or a zero-test quick run records `passed: false`; or the body lacks `Full suite: CI (no code file in this diff)` or still claims a local count with a `- Tests: <n> passed` line"
status: active
changed_by: 2026-11-20-ARK-604-1
---

## Objective

Prove that `ark merge-request open <run>` opens the MR when the run's own commits (`git diff <base or synced>...HEAD`, three dots) change only Markdown files that no program reads or generates, `plan.yml` `test_cases` are all `reuse` or empty, and the last `test.completed` at the head is a passing quick run with every check passing; that `ark merge-request check <run> --stage final` reports the same result; and that the posted body has the line `Full suite: CI (no code file in this diff)`. Serves ARK-604/AC1.

Authoring gate:

1. Protects: the shipping gate of `checkStage` (stage `final`) for a no-code run, and the body that `buildBody` writes for it: the contract of AC1.
2. Fails when: the change lifts only the `mode === "quick"` refusal and leaves the criteria, the test-evidence or the refactor `base_passed` rule refusing a quick result; the own diff uses the first base after a sync; the helper reads every repo of `discoverRepos(config.workspace)` and treats a repo with no worktree (no base to diff against) as code, or a repo with a worktree and no own commit as code; `ark test --quick` records `passed: false` when it selects no test; or the ledger has no no-code field, so the body keeps the old quick Tests line and no `Full suite:` line.
3. Existing proof misses it: ARK-T121 and ARK-T738 prove only the refusal of a quick run on a code diff (`test/own.test.ts`, `e2e.test.ts`); ARK-T120 runs a docs-only quick test but never opens; ARK-T200 (d) builds the body of a quick code run through `buildLedger`. No case opens an MR on a quick result. ARK-T750 owns the refusals; this case owns the accepted path.
4. No test-only export, flag or hook: the case runs the real `ark` process, the real `ark test --quick` and the fake forge of `test/fixtures/merge-request`.

## Preconditions

- The `ark test quick mode gates` fixture of `test/test-selection.test.ts` (`startRun` with `forge: true`), extended: `startRun` takes five new options, each with today's value as its default, so every other caller keeps its fixture: `action` (the plan `test_cases` action, default `add`), `planCases` (the plan `test_cases` as written, default one entry of `action` for each case), `generated` (the `generated` list of `ark.yml`, default none), `repos` (the repos that get a run worktree, default `["."]`) and `manualAc` (a second AC with `manual: true`, default off). The ticket kind is the existing `kind` option. The new `noCodeRun` of the test file sets up the fake forge itself (the fake forge first on `PATH`, `FAKE_LOG` in a temp folder), in the way of `gateRun`; it does not call `gateRun`.
- The base of the workspace holds a passing test titled `FAKE-T1 ...` in `test/existing.test.ts`. The ticket has `AC1` with `method: test` and `verified_by: [FAKE-T1]`. The suite has `base_files`, so a quick run selects only own test files.
- `ark.yml` of the fixture project lists one `generated` entry (`docs/reference/cli.md`), so the eligible diff is read against a real `generated` list.
- One own commit changes only `docs/guide.md` and `skills/demo/SKILL.md` (hand-written Markdown, outside `test/`).
- No `results/evidence/` folder exists for `FAKE-T1` (a quick run writes none).
- Fixtures: (A) `kind: feature`, `test_cases` = one `reuse` entry for `FAKE-T1`; (B) as A with `test_cases: []`, so that `startRun` makes AC1 `method: inspection` (plan check refuses a `test` AC with no integration case) with `verified_by: []`, writes its evidence file `results/evidence/AC1.md` and records `gate record <run> manual FAKE-1/AC1 ok`; (C) as A with `kind: refactor` and no `base_passed` recorded; (D) as A, then after the quick run the target gains `src/target.ts` and `ark worktree sync <run>` merges it cleanly.
- (E) A two-repo workspace: the workspace folder holds the repos `core/` and `site/`, each with a base commit, so `discoverRepos` lists both. The run creates a worktree for `core` only, and the own Markdown commit of A is in `core`. `site` has no worktree in the run, so it has no recorded base and no own commit; `checkStage` reaches it through its workspace checkout.
- (F) As E, with a worktree for `site` too and no own commit in it (its own diff is empty). F is the accepted head of ARK-T750 row 15.
- A repo with no worktree in the run, or with a worktree and no own commit, is not code: it changes no file the run ships. The helper reads the own diff of each run worktree only; a `git diff` that fails in a run worktree still counts as code (refuse).

## Steps

1. Fixture A: run `ark test <run> --quick`. Read the exit code, stdout and the last `test.completed`.
2. Run `ark merge-request check <run> --stage final`. Read the exit code and stdout.
3. Run `ark merge-request open <run>`. Read the exit code, stderr and the body of the recorded `gh pr create` call.
4. Fixtures B and C: run `ark test <run> --quick`, then `ark merge-request open <run>`.
5. Fixture D: run `ark test <run> --quick`, move the target and sync as in the preconditions, then `ark merge-request open <run>`.
6. Fixtures E and F: run `ark test <run> --quick`, `ark merge-request check <run> --stage final`, then `ark merge-request open <run>`. Read each exit code, stderr and the body of the `gh pr create` call.

## Expected results

- Step 1: exit 0. The suite selects no test file (stdout names the skip). `test.completed` has `mode: "quick"`, `passed: true`, and `FAKE-1/AC1` reads `not run`.
- Step 2: exit 0; no problem line.
- Step 3: exit 0; one `merge_request.opened` event; the branch is pushed. The body holds the line `Full suite: CI (no code file in this diff)` exactly once and no line that starts `- Tests: ` with a passed count. stderr holds none of `quick, not a gate`, `criteria not passing`, `test evidence missing`.
- Step 4: each open exits 0 and records one `merge_request.opened`; fixture C is not refused with `refactor run:`.
- Step 5: exit 0. The own diff is read from the synced commit, so the target's `src/target.ts` does not make the run a code run.
- Step 6: for E and for F, the check exits 0 with no problem line, and the open exits 0, records one `merge_request.opened` and posts a body with the line `Full suite: CI (no code file in this diff)`. stderr holds no `quick, not a gate`.
- `lintBody` gives no error for the body of step 3.

## Screenshot checkpoints

none: CLI, event-log and MR-body text case; no UI surface.
