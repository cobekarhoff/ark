---
id: ARK-T324
title: ARK-T324 the base pass of ark test passes when only an untouched repo has a failing suite, and does not run that suite
level: integration
technique: equivalence classes (failing suite in a touched repo vs in an untouched repo)
priority: high
risk: the base pass runs the suite of an untouched repo on the workspace clone, so one red or unrelated suite fails the base check of every run, or it records that suite in the base side (`baseRun`)
status: active
changed_by: 2026-11-12-ARK-416-1
---

## Objective

Prove that the base pass (the check that the base suites passed, on the throwaway base checkout) applies the same rule as the head pass: it runs the suites of `.` and of the run's worktrees only. A failing suite of an untouched repo does not fail it.

Expected: When the only failing suite belongs to a repo with no worktree in the run, the system shall not run it on the base pass and the base pass shall pass.

## Preconditions

- The two-repo fixture workspace of ARK-T323: suites for `a` and `b`, a run with a worktree for `a` only.
- The suite of `a` passes. The suite of `b` is `sh -c 'touch b.marker; exit 1'` (it fails and leaves a marker).
- The run is `kind: refactor` and the `ark.yml` suite of `b` has no `base_files`, so the base pass runs the whole suite of every suite it does not skip, and a base failure is reported (a non-refactor run with `base_files` would skip `b` at base for "no changed test file", and the control would prove nothing). The `ticket.md` has an AC with `method: test`, so a failed base is also a problem. `a` has a worktree with base commits in `worktree.created`.
- The marker path of `b` is absolute, in a folder outside every checkout, so a run at the base checkout or the workspace clone leaves it.

## Steps

1. Run `ark test <run>` in the fixture.
2. Read the output, the marker files, the `test.completed` event in `events.ndjson`, and the folder `results/`.

## Expected results

- The output has the line `base      passed` and the `test.completed` event has `base_passed: true`: the failing suite of `b` did not fail the base pass.
- `b.marker` does not exist: the failing suite of `b` ran on neither pass.
- The output has `skipped <suite of b> (repo b not in run)`; the `suites` array of `test.completed` has no entry for the suite of `b`, and `results/<b suite>.log` and `results/base-<b suite>.log` do not exist.
- Control (same fixture, plus a `worktree.created` event for `b`): `b.marker` exists, the output has `base      failed`, the event has `base_passed: false`, and the run ends with `refactor run: the suites fail at the base commit`. Only the worktree of `b` differs, so the rule, not a guard, made the pass above.

## Screenshot checkpoints

None, CLI output.
