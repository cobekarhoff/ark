---
id: ARK-T665
title: ARK-T665 a run stopped by a failed check records its criteria as missing or not run, never failing, keeps the last good evidence and the heads, and runs no base suite
level: integration
technique: state transition (passing full run, then a failed check, then a failed check with --keep-going) over the consumers of test.completed (bug-run red proof, ark status head, refactor base run, evidence folder)
priority: high
risk: "a stopped run records a criterion as failing, so the bug-run red proof (ARK-302-AC5) passes with no failing test and the implementer starts on a fake proof; the stop publishes an empty staging folder and wipes results/evidence of the last good run; the stop drops the heads, so ark status and merge-request check read the test as current or never run; the stop runs the slow base suites, or a refactor run is refused for a base it never ran; a stopped event counts passed tests or suites that did not run"
status: active
changed_by: 2026-11-14-ARK-481-1
---

## Objective

Prove the shape of the `test.completed` event of a stopped run and what its readers do with it. ARK-T664 owns the stop itself: this case owns the event and the files the stop leaves. Serves ARK-481/AC1 ("writes `test.completed` with passed false and the failed checks").

Expected: When `ark test <run>` stops after a failed check, the system shall record every criterion as `missing` (full) or `not run` (quick), never `failing`, keep `results/evidence` of the last published run, record the heads, and run no base suite.

## Preconditions

- Fixture of `test/test-run.test.ts` (`buildingRun`, `kind: bug`) with one criterion `FAKE-1-AC1` (`method: test`) verified by an e2e test. It configures the two suites `unit` and `e2e`. One check, `lint`, whose command exits 1 while the file `check-fails` exists and 0 otherwise. The `e2e` suite command writes a marker file.
- A second fixture, `kind: refactor`, with the same suites and check, where each suite has a `base_command` that writes a base marker (`base-ran`).
- Plan has a `build` step with role `implementer`.

## Steps

1. Bug run, no `check-fails` file: `ark test <run>` passes. Read `results/evidence/` and keep a copy of its file list.
2. Create `check-fails`. Run `ark test <run>`. Read the output, stderr, the last `test.completed`, `results/evidence/`, the staging folder of the run, and `ark status <run>`.
3. Run `ark run step <run> build start`.
4. Commit a change that makes the suite test fail. Run `ark test <run> --keep-going` with `check-fails` present. Read the criteria of `test.completed`. Run `ark run step <run> build start` again.
5. Fresh bug run, `check-fails` present: run `ark test <run> --quick`. Read the output, stderr and the criteria.
6. Fresh refactor run, `check-fails` present: run `ark test <run>`. Read the output, stderr, `test.completed` and the base marker.

## Expected results

- Step 2: exit 1. The run is stopped, so the output has no `FAKE-1/AC1  ...` criterion line, and stderr is `ark: tests did not prove every criterion: check lint failed` and a newline (`cli/test-runner.ts:212`), with no `missing` criterion in the text. `test.completed` has `passed: false`, `suites: []`, `passed_count: 0`, `skipped: 0`, the failed check `lint`, the head of each repo (the same heads a full run records), and `FAKE-1/AC1` is `missing` (the event records it even though the run prints no criterion line). `results/evidence/` holds the file list of step 1, unchanged, and no staging folder is left. `ark status` shows the test head as current.
- Step 3: refused with `record a failing ark test of the ACs before the fix` in the error (the full text is `step.started refused: bug run: record a failing ark test of the ACs before the fix`, `cli/transitions.ts:116`): the stopped run is no red proof.
- Step 4: `--keep-going` runs the suites, so the output prints `FAKE-1/AC1  failing`, stderr holds `check lint failed` and `suite e2e failed` after the prefix `ark: tests did not prove every criterion: `, `FAKE-1/AC1` is `failing` in `test.completed`, and `step.started` for `build` is allowed.
- Step 5: exit 1, no criterion line in the output, stderr `ark: tests did not prove every criterion: check lint failed` and a newline; `FAKE-1/AC1` is `not run` in `test.completed`, not `missing`, `failing` or `passing`.
- Step 6: exit 1. No base marker. The output has no `base ` result line (no `base      passed` and no `base      failed`) and no `refactor run: the suites fail at the base commit`; stderr is `ark: tests did not prove every criterion: check lint failed` and a newline, and holds nothing else. `test.completed` has `passed: false` and no `base_passed` key. The run stops because of the check, not because of a base it never ran. Reader named under the AGENTS.md rule for readers that skip an item: `deriveState` keeps the last `base_passed` when a stopped event has none (`cli/events.ts:332`, `data.base_passed ?? basePassed`), so `ark merge-request check` (`cli/merge-request.ts:523-529`) may still read an older `true` from a full run. The stopped run is refused there because `passed` is false, so the case asserts `passed: false` and the absent key, and no base verdict.
- This case asserts nothing about `red_on_main` of a stopped run: the plan did not decide it.

## Screenshot checkpoints

none: the surface is the event log and run files, which the test reads as text.
