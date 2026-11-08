---
id: ARK-T122
title: ARK-T122 a refactor run still runs the whole suite at the base, and a case that does not run at base is not run, not failed
level: integration
technique: "decision table (kind refactor vs feature) x (base result: passed, failed, case absent)"
priority: high
risk: a refactor run is gated on a partial base run (behavior-preserving proof is lost); or base_passed is recorded from a partial run for another kind; or a failing base case is hidden as not run
status: active
changed_by: 2026-11-08-ARK-389-1
---

## Objective

Prove that a `kind: refactor` run runs every test file of every suite at the base commit, as before, even when the run's own commits changed one test file, records `base_passed`, and that a case which ran at base and failed still reads `failed` at base (a failing base case is never hidden as `not run`). Serves ARK-389/AC1 (refactor clause). The feature-run file selection and the `not run` status are owned by ARK-T119 and are not repeated here.

Expected: Where a run is of kind refactor, the system shall run the whole suite at the base commit, and a case that failed there shall read failed at base.

ARK-T12 and ARK-T63 own the base-pass gate (refusal and exemption); this case owns the refactor base file selection and does not repeat the gate.

## Preconditions

- A temporary `ARK_HOME`, project and git repo, a suite with `base_files` and `base_command`, and a base commit with two test files: `test/a.test.ts` (changed by the run's own commit) and `test/b.test.ts` (never changed). Each file writes its name to a marker file when it runs. `test/b.test.ts` holds a case that fails at base and at head; `test/a.test.ts` holds a case that passes at both.
- One `kind: refactor` run with a `method: test` AC served by the passing case.

## Steps

1. Run `ark test` on the refactor run. Read the base marker file, `test.completed` and `results/evidence/<id>/base/result.json` of both cases.

## Expected results

- The base run executed both `test/a.test.ts` and `test/b.test.ts` (the unchanged file runs: refactor selects no files).
- `test.completed.base_passed` is recorded (as `false`, because the case in `test/b.test.ts` fails at base).
- The case in `test/b.test.ts` has base status `failed`, not `not run`; the case in `test/a.test.ts` has base status `passed`.

## Screenshot checkpoints

none: integration case on CLI output and files; no UI surface.
