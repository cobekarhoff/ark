---
id: ARK-T2
title: ARK-T2 ark test writes base and head result.json with different SHAs
level: integration
technique: equivalence classes of outcome (failed/passed/skipped) and a base-crash boundary
priority: high
risk: a case has no base or head folder, result.json lacks the id/name/status/sha fields, the base SHA equals the head SHA in a touched repo, or a base crash leaves a case with no base evidence
status: active
changed_by: 2026-11-06-ARK-312-1
---

## Objective

Prove `results/evidence/<case id>/{base,head}/result.json` is written for every case id the parsers find, with the right fields (`case`, `name`, `status`, `sha`, `repo`) and the SHA of the checkout that ran.

## Preconditions

- Fake project as in ARK-T1, run `kind: feature`, with two touched repos and one untouched repo:
  - `touched`: base commit and a distinct head commit.
  - `touched2`: a mirror/worktree setup where the composed workspace checkout head differs from the mirror head (a commit exists only in the workspace checkout), so a wrong checkout choice yields a wrong SHA.
  - `untouched`: no change in the run; base and head are the same commit.
- Expected SHAs come only from git in the fixture: `git -C <repo base checkout> rev-parse HEAD` for base, and `git -C <workspace checkout that ran> rev-parse HEAD` for head, captured by the test before invoking `ark test`. The `worktree.created` event is written by the fixture from the same `rev-parse`. Never call `headOf` or any function of the code under test to compute an expectation.
- Suite A (in `touched`): `FAKE-T1` fails at base, passes at head; `FAKE-T2` passes both; `FAKE-T3` skipped at both.
- Suite B (crash fixture, in `touched`): new test file with `FAKE-T4` importing a module existing only at head, so at base the file fails to load and the JUnit has no entry for `FAKE-T4`.
- Suite C (in `touched2`): `FAKE-T5` passes both. Suite D (in `untouched`): `FAKE-T6` passes both.
- JUnit names: `FAKE-T1 fails at base`, `FAKE-T2 passes`, `FAKE-T3 is skipped`, `FAKE-T4 needs head module`, `FAKE-T5 workspace`, `FAKE-T6 untouched`.

## Steps

1. Run `ark test` on suites A, C, D.
2. For every FAKE-T1, T2, T3, T5, T6 list `results/evidence/<id>/`; assert `base/` and `head/` exist.
3. Parse each `result.json`; assert it has `case`, `name`, `status`, `sha` and `repo` (the repo of the suite that ran it).
4. Assert per case `case` equals the id, `name` equals the exact JUnit name above, and statuses, for both `base/` and `head/` of all six cases: T1 base failed / head passed; T2, T5, T6 both passed; T3 both skipped. T4 is covered in step 6.
5. Assert `sha` for both sides of every case against the git-derived values, never against the code under test: T1, T2 and T3 base `sha` equals the `touched` base SHA and head `sha` equals the `touched` head SHA, and base differs from head. T5 base `sha` equals the `touched2` base SHA and head `sha` equals the workspace checkout head, not the mirror head. T6 base `sha` equals head `sha` equals the untouched repo's one SHA.
6. Run `ark test` on suite B. Assert `FAKE-T4/base/result.json` has `case` `FAKE-T4`, `name` exactly `FAKE-T4 needs head module`, status `failed` and the `touched` base SHA; `FAKE-T4/head/result.json` has `case` `FAKE-T4`, name `FAKE-T4 needs head module`, status `passed` and the `touched` head SHA. Assert `FAKE-T4/base/command.log` exists and is byte-identical to the suite B base command.log shared by every case of that suite (first line the suite command, last line `exit <code>`).
7. Deleted file: in a one-repo fixture with one suite over `test/`, delete `test/old.test.ts` (FAKE-T1) at head and keep `test/keep.test.ts` (FAKE-T2). Run `ark test`. Assert FAKE-T1 `base/result.json` is `passed`, `head/result.json` is `failed` with the head SHA and the exact JUnit name, and `head/command.log` equals FAKE-T2's head `command.log` (the suite's, last line `exit 0`).
8. Two suites, one case: suite `first` fails FAKE-T1 and suite `second` passes it. Assert both sides' `result.json` are `failed` with the failing test name, and both sides' `command.log` hold both suite commands and the `1 fail` output.
9. Re-run `ark test` after the head test file drops FAKE-T2. Assert `results/evidence/FAKE-T2` is gone and the other case folders remain.

## Expected results

- When `ark test` finds a case id, the system shall write `result.json` with the case id, the exact JUnit name, the status and the commit SHA of the checkout that ran to its `base/` and `head/` folders.
- When a case ran in a touched repo, the system shall record the repo's base SHA in `base/result.json` and the head SHA of the checkout that ran in `head/result.json`, and the two shall differ.
- When a case ran in an untouched repo, the system shall record the same SHA in `base/` and `head/`.
- If the base run crashes before reporting a case that head reports, then the system shall write a `result.json` with status `failed` and the base SHA to that case's `base/` folder, and shall write the suite `command.log` there.
- If a run reports a case on one side only, for example a test file the run deleted (it stays at base), then the system shall write a `result.json` with status `failed` and that side's SHA, and the suite `command.log`, to the missing side.
- When suites share a case id, the system shall keep the failed result of any of them and the command output of all of them.
- When a case id no longer appears in the results, the system shall remove its evidence folder.

## Screenshot checkpoints

none: integration case on JSON files; no UI surface.
