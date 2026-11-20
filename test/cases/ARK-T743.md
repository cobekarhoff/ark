---
id: ARK-T743
title: ARK-T743 A test over slow_test_s whose test case entry gives a slow_reason is listed with that reason and does not fail the run, also with on_over fail
level: integration
technique: equivalence classes of the entry a slow test maps to (entry with reason, entry without reason, no entry, retired entry, several ids, entry in another repo) in fail mode, with each entry change made on the run's branch
priority: high
risk: the reason is read from the wrong checkout (the workspace's own checkout instead of the run's worktree, so a reason added or removed on the run's branch is not seen) or from the wrong repo (only the root repo, or every repo merged), so a reason is ignored or a foreign reason excuses a test; a test with a reason still fails the run in fail mode, or is dropped from the list, or is listed with no reason so a reader cannot tell it from a failing one; a test with no case id, no entry, an entry with no `slow_reason`, an empty `slow_reason`, a retired entry or a deleted entry is excused; a front matter reader that does not know `slow_reason` refuses a case file or requires the field
status: active
changed_by: 2026-11-20-ARK-581-1
---

## Objective

Prove AC2 of ARK-581 through the real `ark test` process: a test over `slow_test_s` whose entry in `test/cases/<id>.md` of the run's worktree has a `slow_reason` is listed with that reason and does not fail the run, also with `on_over: fail`; a slow test the entry does not excuse still fails.

Authoring gate:

1. Protects: the contract between a case file's front matter (`slow_reason`), the test's case id and the result of a full `ark test`.
2. Fails when: the reader takes no `slow_reason`, takes it from another checkout or repo than the suite's worktree, the excuse is not applied in fail mode, the listed line has no reason, or a test with no id, no entry, no reason, an empty reason, a retired or a deleted entry is excused.
3. Existing proof misses it: `test/test-case.test.ts` and `test/plan.test.ts` read the old field set only, and ARK-T741 and ARK-T742 use no entry. This case is the only owner of the reason, of the test with no case id, and of the readers of the entry. The matrix of the limits stays with ARK-T741, and this case does not repeat it.
4. No test-only export, flag or hook: the real `ark` process, case files in the run's worktree and a fake suite command that writes a report.

## Time source rule (test/wallclock.test.ts, ARK-T126)

As ARK-T741: the times come from a fixture report written by the fake suite command; no sleep. The report has root `time` 6 and four tests: `FAKE-T1 slow with reason` 4.0 s, `FAKE-T2 slow with no reason` 4.0 s, `FAKE-T3 fast` 0.5 s and `slow with no id` 4.0 s.

## Preconditions

- The fixture of ARK-T741 (the `e2e` suite with the fake command, `head.marker` committed on the run's branch) with `slow_test_s: 2`, `on_over: fail`, no `time_budget_s`.
- Entries in `test/cases/` of the repo the suite runs in, valid case files:
  - Committed in the workspace before the run starts (so they are at the base commit and in the workspace's own checkout): `FAKE-T1` with `slow_reason: base reason`; `FAKE-T2` with no `slow_reason`.
  - Committed on the run's branch (`commitFiles`): `FAKE-T1` changed to `slow_reason: head reason`; `FAKE-T3` added with a `slow_reason` (the test is not over the limit).
- `ark test` reads the entries of the run's worktree (`readCaseEntries` of each repo of the mirror, as `cli/test-run.ts:1163`). The base checkout holds a head copy of the files that the run's branch added or changed under `test/`, and the old file where the branch deleted one; the workspace's own checkout holds the base files only.

## Steps

1. Only the excused test. A report with only `FAKE-T1 slow with reason` over 2 s (the others 0.5 s). Run `ark test <run>`; read the exit code, stdout and the last `test.completed`.
2. All four tests as in the Time source rule. Run `ark test <run>`.
3. Same as step 2 with `on_over: warn`.
4. A head commit changes `FAKE-T1`'s entry to `status: retired` (with its `retired_reason`). Run step 1 again.
5. Three head commits in turn (each restores the entry first), each followed by step 1: `slow_reason: ""`; the field removed; the file deleted.
6. A test titled with two ids (`FAKE-T1 FAKE-T2 both`, 4 s): once with `FAKE-T2` still without a reason, and once with a head commit that gives `FAKE-T2` a reason too. Run `ark test <run>`.
7. Two repos. The fixture of `repoFilterRun` in `test/test-run.test.ts` (ARK-416: `repos/a`, `repos/b`, both in the run), with the keyed suite in `repos/b` and the report of step 1. Run 7a: a head commit in `repos/b` gives `FAKE-T1` a reason, and `repos/a` has no `FAKE-T1`. Run 7b: `repos/b` has `FAKE-T1` with no reason, and a head commit in `repos/a` gives `FAKE-T1` a reason.

## Expected results

- Step 1: exit 0, `passed: true`. The output lists the test with its 4.0 s and `head reason` (the head's text, not `base reason`), and marks the line as excused: a reader can tell it from a failing slow test (the validator pins the exact wording from the implementation and asserts that the failing marker of step 2 differs from it). The run does not fail.
- Step 2: exit 1, `passed: false`. `FAKE-T1 slow with reason` is listed with its reason and is not named as a reason for the failure. `FAKE-T2 slow with no reason` and `slow with no id` (a test with no case id has no entry) are listed as slow with no reason and cause the failure. `FAKE-T3 fast` is not listed.
- Step 3: exit 0, `passed: true`; the same three slow tests are listed, only the first with a reason.
- Step 4: a retired entry's reason is not applied: exit 1 in fail mode with the test listed as slow with no reason (the case chooses this rule; see Open rule). The case file is read without an error.
- Step 5: an empty reason, a removed field and a deleted file each leave the test as slow with no reason: exit 1, not excused. A reader of the workspace's own checkout or the base checkout still sees `base reason` after the deletion and excuses the test.
- Step 6: with `FAKE-T2` lacking a reason the run exits 1 (every id of the title must give a reason); with both reasons set it exits 0 and lists both reasons.
- Step 7: 7a exits 0 and lists the reason of `repos/b`'s entry (a reader of the root repo only misses it). 7b exits 1: a reason in another repo's entry does not excuse the test (a reader that merges every repo's entries excuses it).
- In every step: no run prints a `test case entry` problem or exits before its suites ran: an entry with `slow_reason` and an entry without it are both valid (the front matter reader of `ark test` neither refuses the key nor requires it). `ark plan check` reads the same entries through `readWorkspaceCases` (`cli/plan-check.ts:546`), which calls `readCaseEntries`, so the key is one reader's contract; `ark test-case new` reads only the file names of `test/cases/` and needs no case.

## Open rule

The strategy of the run says a test with two ids needs a rule and a retired entry needs a decision; the evaluation lists both without choosing. This case writes "every id must give a reason" and "a retired entry gives none" as the safe defaults (an unexcused slow test fails). If the implementer picks another rule, the run lead amends steps 4 and 6 before the validator writes tests.

## Screenshot checkpoints

none: CLI output and event-log case; no UI surface.
