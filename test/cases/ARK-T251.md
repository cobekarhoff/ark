---
id: ARK-T251
title: ARK-T251 retro counts MR comments and commits after open by MR URL, after the run worktree is deleted
level: integration
technique: state transition (worktree present, then deleted), equivalence classes (GitHub MR, GitLab MR, one MR, two MRs, tool cannot answer)
priority: high
risk: retro asks gh or glab for an MR by number from the run worktree, which `ark run close` deletes before retro runs, so every closed run gets mr_comments and mr_commits_after_open as "unknown" instead of the real count
status: active
changed_by: 2026-11-11-ARK-377-1
---

## Objective

Prove that `ark retro <run>` reads each MR with its URL, from a folder that is not the run worktree, and writes the real MR comment count and the number of commits after the MR opened to `metrics.json`. Serves ARK-377/AC1.

Expected: When ark retro runs for a closed run whose worktree is deleted, the system shall read each merge request by its URL and write the number of comments and of commits after open to metrics.json.

## Preconditions

- A temporary `ARK_HOME` with a project and a closed run whose events hold two `merge_request.opened` events: one GitHub URL (`https://github.com/acme/web/pull/7`) and one GitLab URL (`https://gitlab.com/acme/api/-/merge_requests/9`), each with its open time.
- `<run folder>/workspace/` does not exist. Do not use the fixture's `beforeEach` that creates the worktree directory. `ark retro` runs from a different cwd (a fresh temp folder).
- A fake `gh` and a fake `glab` first in `PATH`. Each records its args to a file. Each accepts only a call that names the MR from the URL, and exits 1 on anything else:
  - `gh`: a PR view/list call whose argument is the full PR URL, or an API endpoint with the URL-derived path `repos/acme/web/pulls/7/...`, `repos/acme/web/issues/7/...`.
  - `glab`: an `api` call whose endpoint is the URL-derived `projects/acme%2Fapi/merge_requests/9/notes` or `.../commits`, with host `gitlab.com` (`--hostname gitlab.com` or `GITLAB_HOST`).
  - Both reject a bare MR number, a `:fullpath`/`:id` placeholder, an endpoint with no project, and a call that relies on the cwd to find the repo.
    Each answers from the MR it got:
  - GitHub MR: 2 issue comments, 1 review with a body, 1 review with an empty body; 3 commits, 1 dated before the open time and 2 after.
  - GitLab MR: 3 notes, 1 of them `system: true`; 4 commits, 1 before the open time and 3 after.

## Steps

1. Build the fixture with the worktree absent and the fake tools in `PATH`.
2. Run `ark retro <run>` from the other cwd.
3. Read `<run folder>/metrics.json` and the fake tools' recorded args.
4. Make the fake `gh` exit 1 and run retro again on a copy of the run.

## Expected results

- `human_intervention.mr_comments` is 5: GitHub 2 comments + 1 review body = 3, GitLab 3 notes - 1 system note = 2. The empty review body is not counted.
- `human_intervention.mr_commits_after_open` is 5 (2 GitHub + 3 GitLab). Commits before the open time are not counted.
- The recorded args show `gh` called with the GitHub PR URL or its `repos/acme/web/...` endpoint, and `glab` called with `projects/acme%2Fapi/merge_requests/9/...` and host `gitlab.com`. No recorded call has a bare number, `:fullpath`, or a project-less endpoint.
- Step 4: `mr_comments`, `mr_commits_after_open`, `mr_sync_commits` and `mr_fix_commits` are all `"unknown"`, not 0.

## Screenshot checkpoints

None. The surface is a JSON file; no screenshot applies.
