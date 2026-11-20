---
id: ARK-T728
title: ARK-T728 ark merge-request status attributes GitHub checks and GitLab head-pipeline job failures to each merge request
level: integration
technique: equivalence classes (GitHub check conclusion and status states, GitLab job failure, passing and pending entries, three repos)
priority: medium
risk: "status lists a passing or pending check as failing, drops a failing check of the legacy status shape, mixes the checks of two MRs, or reads no failed job of a GitLab head pipeline, so a human sees a wrong or empty failure list; or status appends a run event"
status: active
changed_by: "2026-11-20-ARK-600-1"
---

## Objective

Prove that `ark merge-request status` prints one line for each open merge request with `ci: failed` and the names of its failing checks: GitHub entries with a failing `conclusion` or `state` (`FAILURE`, `ERROR`, `TIMED_OUT`), the failed jobs of a GitLab head pipeline, and no passing or pending entry; and that it writes no event. The case converts the legacy test ARK-208-AC3 ("status attributes GitHub checks and GitLab head-pipeline job failures to each MR") of test/post-mr.test.ts; its title carries this case id after the conversion, and it gets its own `{ timeout }` of at least 30 s because it builds its run through `openRun(` (ARK-600).

## Preconditions

- A scratch ARK_HOME and a fake `orca` executable on PATH (`test/fake-orca.ts`); no real Orca, omp or test-runner.
- A run with three open merge requests (repos `.`, `github-other` and `gitlab`) and a fake `gh` and `glab` on PATH that answer as the test file's `emulateHosts` writes them.
- A scratch git repo recorded as the run's worktree.

## Steps

1. Build the run as the preconditions say, with the `ark` commands, and read the events.
2. Run `ark merge-request status <run>`, then read the events again.

## Expected results

- Exit code 0; three lines: `.  open  <github pull 1>  ci: failed  checks failing: linux-test, legacy-lint`, `github-other  open  <github pull 2>  ci: failed  checks failing: other-repo-test` and `gitlab  open  <gitlab merge request 3>  ci: failed  checks failing: gitlab-test, gitlab-lint`.
- The passing and the pending GitHub entries are not named; the events are equal to those before the command.

## Screenshot checkpoints

None. The surface is CLI output; no screenshot applies.
