---
id: ARK-T729
title: ARK-T729 ark merge-request status prints ci: failed for a GitLab pipeline that failed, and never passed
level: integration
technique: equivalence classes (GitLab pipeline failed with no failed job listed, against GitHub with named checks)
priority: medium
risk: "status prints ci: passed, or nothing, for a GitLab head pipeline that failed when no failed job is listed, so a human merges a red MR"
status: active
changed_by: "2026-11-20-ARK-600-1"
---

## Objective

Prove that when the GitLab pipeline failed and the host lists no failed job, `ark merge-request status` still prints `ci: failed` for that merge request, with no `checks failing:` list, while the GitHub merge request keeps its named checks. The case converts the legacy test ARK-208-AC3 ("status prints ci: failed when the GitLab pipeline failed, never passed") of test/post-mr.test.ts; its title carries this case id after the conversion, and it gets its own `{ timeout }` of at least 30 s because it builds its run through `openRun(` (ARK-600).

## Preconditions

- A scratch ARK_HOME and a fake `orca` executable on PATH (`test/fake-orca.ts`); no real Orca, omp or test-runner.
- A run with two open merge requests (the GitHub `.` and the GitLab `gitlab`) and a fake `gh` and `glab` on PATH whose GitLab pipeline failed with no failed job.
- A scratch git repo recorded as the run's worktree.

## Steps

1. Build the run as the preconditions say, with the `ark` commands.
2. Run `ark merge-request status <run>`.

## Expected results

- Exit code 0; two lines: `.  open  <github pull 1>  ci: failed  checks failing: linux-test, legacy-lint` and `gitlab  open  <gitlab merge request 3>  ci: failed`.
- The output never contains `ci: passed`.

## Screenshot checkpoints

None. The surface is CLI output; no screenshot applies.
