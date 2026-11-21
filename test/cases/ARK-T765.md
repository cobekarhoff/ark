---
id: ARK-T765
title: ARK-T765 a guard AC must read passing in the final full ark test and at merge-request open, and the MR body lists guards apart on create and refresh while a failing guard stays in Not done
level: integration
technique: state transition (full ark test with the guard failing, then passing; merge-request open, then a refresh after a new head) and equivalence classes of the readers of the run's criteria (final test check, open refusal, Acceptance criteria block, Not done, Verification row, VAL03 lint)
priority: high
risk: "the guard exemption of the red proof leaks into the final gates, so `ark test` exits 0 and `ark merge-request open` posts an MR while a guard (the regression the run must not cause) reads `failing`; or the body lists the guard in the status line of the other ACs, so a reviewer cannot tell it apart; or the guard line shows on create but not after the refresh of an open MR; or the guard leaves the status groups and also drops out of `gapsOf` and the Verification row, so a failing guard vanishes from Not done and VAL03 still passes"
status: active
changed_by: 2026-11-21-ARK-617-1
---

## Objective

Prove that a guard AC gets no exemption after the red proof: the final full `ark test` refuses a guard that reads `failing`, `ark merge-request open` refuses it, and once it passes the body that `open` posts, and the body of the refresh after a new head, list the guard ACs apart from the others. Prove too that every reader of the ledger's criteria keeps a failing guard: Not done and the Verification row list it. Serves ARK-617/AC2.

Authoring gate:

1. Protects: the final test check of `cli/test-run.ts`, the `criteria not passing` refusal of `cli/merge-request.ts`, and the readers of `ledger.criteria` in `skills/pr-writing/lib/` (`acsBlock`, `gapsOf`, the Verification row of `riskBlock`), on both MR entry points of `ark merge-request open` (create, refresh).
2. Fails when: the final check or the open refusal skips guards (steps 1 and 2 turn red), the guard is not on a line of its own (step 3), the refresh path builds the body without the guard data (step 4), or a failing guard leaves Not done or the Verification row (step 5).
3. Existing proof misses it: ARK-T665 and ARK-T640 own the final test check and the open refusal for runs with no guard; ARK-T37 owns the body sections and the `[x] AC1 tested` line; ARK-T57 owns the refresh of an open MR. None has a guard. This case adds the guard to each; it does not re-own their other rows.
4. No test-only export, flag or hook: steps 1 to 4 run the `ark` process with the fake `gh` of `test/merge-request.test.ts`; step 5 builds the body from the ledger that the pr-writing skill gathers from a run folder, the second entry point that ARK-T52 names.

## Preconditions

- Fixture of ARK-T57 (`testedRun` of `test/merge-request.test.ts`, a fake `gh` that logs each create and edit with its body), changed to `kind: bug` with two criteria: `AC1` `method: test` (verified by `FAKE-T1`) and `AC2` `method: test` with `guard: true` (verified by `FAKE-T2`), the guard set through the real `ark gate record <run> criteria accept --criteria <file>`. The fixture meets every other `assertShippable` prerequisite, as ARK-T57 says, so no other refusal can hide the case.
- A switch file makes the `FAKE-T2` test fail while it exists; `FAKE-T1` passes.
- For step 5: the run fixture of `test/pr-writing.test.ts` (`makeRun`) with the same two criteria, the guard on `AC2`, and a last test that records `AC1` `passing` and `AC2` `failing`.

## Steps

1. With the switch file present, commit, run the full `ark test <run>`. Read the exit code, stderr and the last `test.completed`.
2. Run `ark merge-request open <run>`. Read the exit code, stderr and the fake `gh` log.
3. Remove the switch file, commit, run the full `ark test <run>`, then `ark merge-request open <run>`. Read the posted body.
4. Commit a new head, run the full `ark test <run>`, run `ark merge-request open <run>` again. Read the edited body.
5. Build the body of the `makeRun` ledger with `buildBody` and run the lint of `skills/pr-writing/lib/lint.ts` on it.

## Expected results

- Step 1: exit 1; stderr holds `tests did not prove every criterion` and `/AC2 is failing`; `test.completed` has `passed: false` and `AC2` `failing`.
- Step 2: exit 1; stderr holds `criteria not passing in the last test run` and names `AC2 (failing)`; the fake `gh` logs no create and no edit; the phase is not `merge_requests_open`.
- Step 3: both commands exit 0. In the posted body's `## Acceptance criteria` section, `AC1` is on `- [x] AC1 tested` as today; `AC2` is on a line of its own that holds the word `guard` and a ticked box; no line holds both `AC1` and `AC2`; each id is in the section once.
- Step 4: exit 0; one edit and no second create; the edited body's `## Acceptance criteria` section is as in step 3.
- Step 5: the `## Acceptance criteria` section lists `AC2` apart from `AC1` with an unticked box; `## Not done` holds `AC2 not proven: failing`; the Verification row of `## Risk and revert` names `AC2 failing`; the lint reports no VAL03 failure (every gap is in Not done).
- This case does not assert the label text beyond the word `guard`, the red proof (ARK-T763) or the criteria gate (ARK-T764).

## Screenshot checkpoints

none: the surface is CLI output and the MR body text that the fake `gh` logs; no rendered page.
