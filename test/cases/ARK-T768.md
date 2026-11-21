---
id: ARK-T768
title: "ARK-T768 auto-merger with ARK_PROJECT set reads only the runs of that project: no gh call and no 'run not found' line for a run of another project in merge_requests_open"
level: integration
technique: "equivalence classes (run in merge_requests_open in the named project, run in merge_requests_open in another project)"
priority: high
risk: "the auto-merger of one project takes the merge_requests_open runs of another project from `ark status`, so `ark merge-request status --project` fails with `run not found in project` on every pass and floods the log, or the script calls gh for, and merges, a PR of a project it does not own"
status: active
changed_by: 2026-11-21-ARK-622-1
---

## Objective

Prove that one pass of `scripts/auto-merger.sh --once` with `ARK_PROJECT` set to a second project handles the runs of that project only. A run of the first project in `merge_requests_open` gets no `gh` call and no `run not found` line.

## Preconditions

- The fixture of ARK-T295 (`runCleanPullRequestScenario` in `test/chief-scripts.test.ts`), with the project name and the run id as parameters: a `demo` run `2026-11-02-ARK-900-1` in `merge_requests_open` with PR `app` #11 (CLEAN) and `core` #12 (DIRTY), `retro.md` and a ready ticket file.
- A second project `other` with a valid `ark.yml` and one run `2026-11-02-ARK-901-1` in `merge_requests_open` with PR `app` #21 (CLEAN), `retro.md` and a ready ticket file, so the pass has work and the case cannot pass on an empty pass. The two run ids differ: with one id in both projects, `ark merge-request status --project other` finds the `other` run for the `demo` line too, and the case passes at base.
- The fake `gh` that logs every call; the fake `orca`; real `ark` on PATH.

## Steps

1. Run `scripts/auto-merger.sh <workspace> 1 --once` with `ARK_PROJECT=other`.
2. Read the exit code, stdout, stderr and the `gh` call log.

## Expected results

- When the pass ends, the system shall exit with code 0.
- When `ARK_PROJECT=other` is set, the system shall call `gh pr merge https://github.com/org/app/pull/21 --merge`.
- When `ARK_PROJECT=other` is set, the system shall make no `gh` call that names `pull/11` or `pull/12`.
- When `ARK_PROJECT=other` is set, the system shall write no line that contains `run not found` to stdout or stderr.

## Screenshot checkpoints

none: integration case on a shell script's output and a fake's call log; no UI surface.
