---
id: ARK-T31
title: ARK-T31 merge-request open uses glab on GitLab, writes `Depends on !N` and a native dependency
level: integration
technique: equivalence classes (GitHub, GitLab) over the same two-repo run
priority: medium
risk: a GitLab run calls gh, loses the dependency line, or misses the native blocks call
status: active
changed_by: 2026-11-06-ARK-316-1
---

## Objective

Prove that merge-request open uses glab on GitLab, writes `Depends on !N` and a native dependency. This case replaces the old id ARK-155-AC1 and AC3 (GitLab half), converted when ARK-316 moved the body to a file and the host calls to post.ts.

## Preconditions

- A fixture run with repos core and app on GitLab, and a fake `glab` that records calls and keeps open MRs.

## Steps

1. Run `ark merge-request open <run>`.
2. Read each `glab mr create` call and the `glab api` blocks call.

## Expected results

- Two `glab mr create` calls with `--source-branch ark/<run>`; the app description has `Depends on !1`.
- The events hold the `merge_requests/N` URLs.
- The blocks call is `projects/:fullpath/merge_requests/2/blocks?blocking_merge_request_id=9001`, and no call merges or approves.

## Screenshot checkpoints

none: integration case on CLI output and host calls; no UI surface.
