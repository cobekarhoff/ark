---
id: ARK-T1
title: ARK-T1 ark test runs new tests at base and a base failure does not fail a feature run
level: integration
technique: state transition (base fail / head pass) plus equivalence classes of run kind (feature vs refactor)
priority: high
risk: ark test skips base for non-refactor kinds, copies no head test files into base, or lets a base failure fail a feature run; or a head failure stops failing the run
status: active
changed_by: 2026-11-06-ARK-312-1
---

## Objective

Prove that `ark test` runs every suite at the `worktree.created` base commit for a `feature` run, after copying the head's added or changed test files into the base checkout, and that a base failure is data: `ark test` exits 0.

## Preconditions

- A fake project in a temp dir (same helper the existing `test/test-run.test.ts` uses): git repo with a base commit holding `src/feature.ts` without `feature()`, and a head commit that adds `src/feature.ts: feature()` and a new file `test/new.test.ts` (calls `feature()`, title starts with `ARK-T1`-style case id of the fake plan, e.g. `FAKE-T1`).
- Run state: `kind: feature`, a `worktree.created` event holding the base SHA, fake test config with one suite (`bun test {report}` style as the existing fixtures) and a JUnit parser.
- Second fixture (same repo, `kind: refactor`) where the suite fails at base, for the contrast step.
- Third fixture: `kind: feature` where the new test also fails at head.
- Run in-process through the `ark test` function used by existing tests, or the CLI with `ARK_HOME` set to a temp dir. No mocking of git.

## Steps

1. Create the feature fixture. Confirm by hand-running the new test in the base tree that it fails (`feature` is not a function) so the premise holds.
2. Run `ark test` for the feature run.
3. Read the exit code and the base suite checkout used by the run (the base worktree path, or the base `command.log`/output).
4. Assert the base checkout held `test/new.test.ts` with the head's content (the base log shows the test ran and failed with a runtime error, not "no tests found").
5. Run `ark test` for the refactor fixture whose suite fails at base. Record the exit code.
6. Run `ark test` for the feature fixture where the new test fails at head. Record the exit code.
7. Run `ark test` twice in a row for the feature run, with a changed test file between runs. Assert the second run's base used the second file content (no base cache across runs).

## Expected results

- When a new test fails at base and passes at head in a `feature` run, the system shall exit 0 from `ark test`.
- When `ark test` runs, the system shall copy the head's version of each added or changed file under a `test`, `tests` or `features` folder into the base checkout before the base suites run.
- When `ark test` runs a `feature`, `bug` or `perf` run, the system shall run the suites at base on every invocation and shall not reuse an earlier base result.
- When the suites fail at base in a `refactor` run, the system shall exit non-zero.
- When a suite fails at head, the system shall exit non-zero for every kind.

## Screenshot checkpoints

none: integration case on CLI exit codes and files; no UI surface.
