---
id: ARK-T380
title: "ARK-T380 ark test prints the head problems of the merge-request check under a heading, changes neither its exit code nor passed, and open refuses with the same line"
level: integration
technique: equivalence classes (head problem present or absent) against test outcome (green, red), with the control that the exit code and passed equal the run without the problem
priority: high
risk: "ark test hides an AC string that open will refuse later (the D11 loop: a 7-14 minute test runs again after the fix), prints the heading on a clean run and breaks tests that compare whole output, prints after the failure throw so a red run shows nothing, lists a final-stage problem (missing evidence) that is not due yet, or turns the information into a gate by changing the exit code or passed in test.completed"
status: active
changed_by: 2026-11-13-ARK-405-1
---

## Objective

Prove that at its end `ark test <run>` runs stage `head` and prints each problem under the heading `merge-request check`; that this is information only; and that `ark merge-request open` later refuses with the text of the printed line.

## Preconditions

- Fixture rule (order matters; ARK-405 review 4): `ark run start` fixes the run's criteria (`cli/run.ts:99`, `cli/events.ts:190`), and `ark gate record <run> manual AC2 ok` refuses an AC that is not in that list (`cli/gate.ts:68-69`: `criterion FAKE-1/AC2 is not in the ticket`). A second `ark plan check` after an edit of `plan.yml` clears the approval and sends the phase back to `planning` (`cli/events.ts:230`, `:366`). So the ACs and the plan are written BEFORE `ark run start` and its `plan check`: `syncedRun` of `test/sync-base.test.ts` gets new options for them (for example `criteria` and `plan`) and writes them where it now writes its one-AC ticket and its plan. After `syncedRun` returns the test never edits `plan.yml` or the criteria, and never runs a second `plan check`; evidence files, commits, gate answers and appended events are fine after the return. The only later edit of the ticket would be an AC text with the same ids, and this case needs none.
- Fixture: `syncedRun("feature", { verified: true, criteria, plan })` with those options, so `FAKE-1/AC1` is `verified_by: [FAKE-T1]` and the suite test is titled `FAKE-T1 works`. The ACs: `FAKE-1-AC1` (`method: test`, `verified_by: [FAKE-T1]`) has text that holds the backticked string `` `no-such-string-405` `` that no tracked file holds, and `FAKE-1-AC2` (`method: analysis`) has no evidence file. The plan has a `summary.changes` row for each AC and the step `build` (implementer) serves both. The step `build` is neither started nor finished: step 1 still expects the AC-string line because the AC-string deferral sits at the validator finish, never in stage `head` (test-design Notes). A stage `head` that applies the deferral would hide the line and fail step 1; that is the risk of this case and the rule stays out of `head`.
- Every fixture is its own `syncedRun` call, and each call runs `tempArkHome`, which resets `process.env.ARK_HOME` (`test/helpers.ts:19-23`). Before each `ark` command the test sets `ARK_HOME` back to the `ARK_HOME` of the fixture it works on (for example the problem fixture again in step 5, after the control fixture of step 2 and the variant of step 4 were built). Each fixture has the fake host of `test/fixtures/merge-request` first on `PATH` (`useFakeHost()` of `test/sync-base.test.ts:264`), so the origin path with `github.com` (`test/sync-base.test.ts:86`) never makes `tokenOwner` run the real `gh api user`.
- `AC2` is answered with `ark gate record <run> manual AC2 ok` before the first `ark test` of each fixture (an analysis AC with no file writes no file, ARK-T6). Without that answer `ark test` itself exits 1 with `FAKE-1/AC2 is manual pending`, the existing behaviour of every manual criterion, and the exit code could not show that the head block changes nothing.
- Problem fixture: the fixture above. Control fixture: a second `syncedRun` with the same options, plus a tracked file that holds the string (committed before the first `ark test`).
- Variant fixtures: a third `syncedRun` as the problem fixture and a fourth as the control fixture, in each the suite test `FAKE-T1` made to fail by a commit in the worktree. If the commit edits `test/own.test.ts`, it touches the old-id title `FAKE-1-AC1 works` of that file: the old-id check is a failed check at the end, not an early throw (`cli/test-run.ts:1141`), so the head block still prints before the throw. Both variants make the same edit, so both runs fail alike and the error texts compare equal in step 4.

## Steps

1. Run `ark test <run>` in the problem fixture. Assert exit 0, and an output block headed `merge-request check` that holds the line ``AC string in no tracked file at head: FAKE-1/AC1 `no-such-string-405` `` (the AC by its canonical id). Assert the block holds no `evidence missing` line (the file of `AC2` is a final-stage problem; `AC2` is answered, so it does not fail the run).
2. Read the last `test.completed` event: `passed` is true. Run `ark test <run>` in the control fixture and assert exit 0, `passed` true, and that the output has no `merge-request check` heading at all.
3. Compare the two outputs after removing the block of step 1: their `tests`, `criterion` and `evidence` lines are the same (the test, criteria and result lines are untouched). The `suite` lines are left out of the comparison, because a suite line may carry a `reused` suffix.
4. Run `ark test <run>` in the variant (failing suite) with the problem present. Assert a non-zero exit with the same error text as the same variant in the control fixture, `passed` false, and that the heading and the line are in the output (printed before the failure is thrown).
5. In the problem fixture after step 1 run `ark merge-request open <run>`. Assert it is refused and that its error text is the line of step 1 byte for byte (`AC2` is answered, so open reaches the AC-string refusal). Add the string to a tracked file, commit, run `ark test` again: no heading. Run open again: it is refused, but with `refused: evidence is not complete` and the line `evidence missing: AC2 (analysis)`. That line is a final-stage problem: it was not in the head block of step 1. The AC-string line is gone because the string was added.
6. Compare the `test.completed` events of the problem run (step 1) and the control run (step 2): they differ in no key (no new key in `data`); the head list is not recorded as a gate.

## Expected results

- When stage `head` lists a problem at the end of `ark test`, the system shall print each problem under `merge-request check`.
- When it lists none, the system shall print no heading and no other new line.
- The system shall keep the exit code of `ark test` and `passed` in `test.completed` as they are without the stage, also for a failing run, which still prints the block.
- The block shall hold no problem of stage `step` or `final`.
- The line shall be the text that `ark merge-request open` refuses with for the same cause.

## Screenshot checkpoints

none: integration case on CLI output and events; no UI surface.
