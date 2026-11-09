---
id: ARK-T119
title: ARK-T119 a feature run runs at the base only the test files of its own commits, ignores merge-in test files, and shows an unrun head case as not run at base
level: integration
technique: equivalence classes (own file, merge-in file, file added then deleted, suite with no changed file) on one run
priority: high
risk: the base reruns the whole suite or the test files that a merge of main brought (lock time stays 154 min per run); or a head case that never ran at base reads "failed at base"; or a suite with no changed file still pays for the base checkout and setup
status: active
changed_by: 2026-11-08-ARK-389-1
---

## Objective

Prove that for a `kind: feature` run, `ark test` runs at the base commit only the test files that the run's own commits add or change (`git log --first-parent --no-merges --name-only <base>..HEAD`, files that still exist at head), through the suite's `base_command`; skips a suite with no such file and prints the reason; and records a head case that did not run at base as `not run at base`, never `failed`. Serves ARK-389/AC1.

Expected: When a feature, bug or perf run is tested at the base, the system shall run only the test files in the commits of the run, skip a suite with none, and report a head case without a base run as not run at base.

The refactor class is owned by ARK-T122.

## Preconditions

- A temporary `ARK_HOME`, project and git repo with a base commit on `main`. The `ark.yml` has two suites: `cli` (parser `bun`, with `base_files: test/**/*.test.ts` and a `base_command` that runs `{files}` and writes `{report}`) and `pw` (a second suite with `base_files` that matches no changed file).
- A `kind: feature` run branch with: commit 1 adds `test/own.test.ts` (case id in the title); commit 2 adds `test/gone.test.ts` and commit 3 deletes it; main then gains `test/main-only.test.ts`, and the branch merges main (a merge commit). `test/untouched.test.ts` exists at base and is never changed.
- Every test file records its own name to a marker file when it runs, so the base run's file list is observable.
- The AC `verified_by` names the case in `test/own.test.ts`.

## Steps

1. Run `ark test <run>`. Read the output, the exit code, the marker file of the base run, `results/` and `results/evidence/<case id>/base/result.json`.
2. Repeat on a branch with no changed test file in any suite (only a source file changed).

## Expected results

- Step 1: the base run executed exactly `test/own.test.ts`. It did not execute `test/untouched.test.ts`, `test/main-only.test.ts` (merge-in) or `test/gone.test.ts` (deleted at head, no error for the missing file).
- Step 1: the output lists the `pw` suite as skipped at the base with the reason `no changed test file`.
- Step 1: the head run executes the whole suite; the case in `test/own.test.ts` passes at head. The case in `test/main-only.test.ts` has base status `not run`, and no case reads `failed` at base.
- Step 1: `ark test` exits 0 and `test.completed.base_passed` is not recorded for a feature run.
- Step 2: no base checkout is created and no base `setup` runs (the marker file is absent); the output prints the skip reason for every suite; exit 0.

## Screenshot checkpoints

none: integration case on CLI output, exit codes and files; no UI surface.
