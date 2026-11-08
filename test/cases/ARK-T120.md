---
id: ARK-T120
title: ARK-T120 a suite with paths is skipped in a quick run when the diff from the base touches none of them, a suite with no paths always runs, and a full run ignores paths
level: integration
technique: equivalence classes and boundary values (diff touches one path, a path folder prefix, no path, merge-in file) plus the no-paths class
priority: high
risk: Playwright runs on every docs-only diff (lock time wasted), or a hub change skips Playwright and ships a broken UI, or the cli suite is skipped on a docs-only diff although 12 tests read docs, or a full run skips a suite by paths, or a skipped suite makes ark test throw "AC is missing"
status: active
changed_by: 2026-11-08-ARK-389-1
---

## Objective

Prove that `ark test --quick` skips a suite that lists `paths` when `git diff --name-only <base>..HEAD` touches none of them, runs it when the diff touches one, never skips a suite with no `paths`, and that a full `ark test` ignores `paths` and runs every suite; each skip is printed with its reason. Serves ARK-389/AC2.

Expected: Where a suite lists paths, when the diff from the base touches none of them, the system shall skip that suite and print the reason; a suite with no paths shall always run.

The diff here is the whole `<base>..HEAD` diff, merge-in files included (unlike ARK-T119, which uses own commits only).

## Preconditions

- A temporary `ARK_HOME`, project and git repo with two suites, `cli` (no `paths`; tests under `test/`) and `pw` (tests under `e2e/`; `paths: [hub/, package.json]`; the `e2e/` folder is deliberately not a listed path). Each suite has one passing test file that writes a marker file when it runs.
- One AC with `method: test` whose `verified_by` case lives in the `pw` suite only.
- Every quick branch below changes one runnable test file in each suite (`test/cli.test.ts` and `e2e/pw.test.ts`), so quick-mode file selection never skips either suite on its own: only `paths` can skip `pw`.
- Five branches from the same base: A adds the two test files and changes `hub/app.ts`; B adds the two test files and changes `docs/x.md`; C adds the two test files and merges a main that changed a file under `hub/` (the run's own commits touch no listed path); D changes only `docs/x.md` (no test file); E adds the two test files and changes `hubble/x.ts`.

## Steps

1. Run `ark test --quick` on A. Read the output and marker files.
2. Run `ark test --quick` on B.
3. Run `ark test --quick` on C.
4. Run a full `ark test` (no `--quick`) on D, a docs-only diff with no changed test file.
5. Boundary: run `ark test --quick` on E (`hubble/` shares the prefix `hub` but is not under `hub/`).

## Expected results

- Step 1: `cli` and `pw` both run at head; no skip line.
- Step 2: `cli` runs; `pw` is skipped and the output prints `skipped` and the reason `diff touches none of: hub/, package.json`. The AC served only by the `pw` case reads `not run` and `ark test` does not throw `AC is missing`. Exit 0.
- Step 3: `pw` runs, because the whole `<base>..HEAD` diff counts for `paths`, merge-in files included (unlike ARK-T119, which uses own commits only).
- Step 4: both suites run their whole head suite, no skip line is printed although the diff is docs-only, and the `pw` marker file exists.
- Step 5: `pw` is skipped with the same reason (`hubble/` does not match `hub/`).

## Screenshot checkpoints

none: integration case on CLI output and files; no UI surface.
