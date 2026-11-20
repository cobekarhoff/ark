---
id: ARK-T743
title: ARK-T743 A test over slow_test_s whose test case entry gives a slow_reason is listed with that reason and does not fail the run, also with on_over fail
level: integration
technique: equivalence classes of the entry a slow test maps to (entry with reason, entry without reason, no entry, retired entry, several ids) in fail mode
priority: high
risk: the reason is read from the wrong file (the base checkout or another repo's `test/cases/`), so a reason is ignored or a foreign reason excuses a test; a test with a reason still fails the run in fail mode, or is dropped from the list, or is listed with no reason so a reader cannot tell it from a failing one; a test with no entry, an entry with no `slow_reason`, or an empty `slow_reason` is excused; a front matter reader that does not know `slow_reason` refuses the case file or drops the field
status: active
changed_by: 2026-11-20-ARK-581-1
---

## Objective

Prove AC2 of ARK-581 through the real `ark test` process: a test over `slow_test_s` whose entry in `test/cases/<id>.md` has a `slow_reason` is listed with that reason and does not fail the run, also with `on_over: fail`; a slow test the entry does not excuse still fails.

Authoring gate:

1. Protects: the contract between a case file's front matter (`slow_reason`), the test's case id and the result of a full `ark test`.
2. Fails when: the reader takes no `slow_reason` or takes it from the wrong checkout, the excuse is not applied in fail mode, the listed line has no reason, or a test with no entry, no reason or an empty reason is excused.
3. Existing proof misses it: `test/test-case.test.ts` and `test/plan.test.ts` read the old field set only, and ARK-T741 and ARK-T742 use no entry. This case is the only owner of the reason. The matrix of the limits stays with ARK-T741, and this case does not repeat it.
4. No test-only export, flag or hook: the real `ark` process, case files in the fixture workspace's `test/cases/` and a fake suite command that writes a JUnit file.

## Time source rule (test/wallclock.test.ts, ARK-T126)

As ARK-T741: the times come from a fixture JUnit report written by the fake suite command; no sleep. The report has root `time` 6 and four tests: `FAKE-T1 slow with reason` 4.0 s, `FAKE-T2 slow with no reason` 4.0 s, `FAKE-T3 fast` 0.5 s and `slow with no id` 4.0 s.

## Preconditions

- The fixture of ARK-T741 with `slow_test_s: 2`, `on_over: fail`, no `time_budget_s`.
- Entries in the workspace repo's `test/cases/` (the repo the suite runs in): `FAKE-T1` has `slow_reason: <a non-empty text>`; `FAKE-T2` has no `slow_reason`; `FAKE-T3` has one (the test is not over the limit).
- The entries are committed in the run's workspace mirror the way the readers of `readCaseEntries` find them (as `test/cases` is read at `cli/test-run.ts:1163`), so the case reads the files a run really has.

## Steps

1. Only the excused test. A report with only `FAKE-T1 slow with reason` over 2 s (the others 0.5 s). Run `ark test <run>`; read the exit code, stdout and the last `test.completed`.
2. All four tests as in the Time source rule. Run `ark test <run>`.
3. Same as step 2 with `on_over: warn`.
4. Change `FAKE-T1`'s entry to `status: retired` (with its `retired_reason`) and run step 1 again.
5. Change `FAKE-T1`'s entry to `slow_reason: ""`, then remove the field, and run step 1 each time.
6. A test titled with two ids (`FAKE-T1 FAKE-T2 both`, 4 s): once with FAKE-T2 still without a reason, and once with both reasons set. Run `ark test <run>`.
7. Put a `slow_reason` on a `FAKE-T1` case of another repo of a two-repo workspace and not on this repo's. Run step 1.
8. Run `ark test-case new` for a key of the fixture, read the created template, and run `ark plan check` and `ark test-case` checks on a workspace whose entry has `slow_reason`.

## Expected results

- Step 1: exit 0, `passed: true`. The output lists the test with its 4.0 s and its reason text, and marks the line as excused: a reader can tell it from a failing slow test (the validator pins the exact wording from the implementation and asserts that the failing marker of step 2 differs from it). The run does not fail.
- Step 2: exit 1, `passed: false`. `FAKE-T1 slow with reason` is listed with its reason and is not named as a reason for the failure. `FAKE-T2 slow with no reason` and `slow with no id` are listed as slow with no reason and cause the failure. `FAKE-T3 fast` is not listed.
- Step 3: exit 0, `passed: true`; the same three slow tests are listed, only the first with a reason.
- Step 4: a retired entry's reason is not applied: the run fails in fail mode with the test listed as slow with no reason (the case chooses this rule; see Open question). The case file is still read without an error.
- Step 5: an empty reason and a missing field both leave the test as slow with no reason, exit 1, in fail mode; neither is excused.
- Step 6: with FAKE-T2 lacking a reason the run exits 1 (every id of the title must give a reason); with both reasons set it exits 0 and lists both reasons.
- Step 7: the reason of another repo's entry does not excuse the test: exit 1.
- Step 8: the template has no required `slow_reason` (a case without it passes every case check); a case file that has `slow_reason` reads without an unknown-key refusal in `ark plan check` and `ark test-case`.

## Open question

The strategy of the run says a test with two ids needs a rule and a retired entry needs a decision; the evaluation lists both without choosing. This case writes "every id must give a reason" and "a retired entry gives none" as the safe defaults (an unexcused slow test fails). If the implementer picks another rule, the run lead amends steps 4 and 6 before the validator writes tests.

## Screenshot checkpoints

none: CLI output and event-log case; no UI surface.
