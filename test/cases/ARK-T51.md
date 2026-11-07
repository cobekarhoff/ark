---
id: ARK-T51
title: ARK-T51 each repo uses the host of its own remote
level: integration
technique: equivalence classes (GitHub repo, GitLab repo) in one run
priority: medium
risk: a mixed-host run posts every MR through one tool
status: active
changed_by: 2026-11-06-ARK-316-1
---

## Objective

Prove that each repo uses the host of its own remote. This case replaces the old id ARK-155-AC1 and AC3 (mixed hosts), converted when ARK-316 moved the body to a file.

## Preconditions

- A fixture run with core on GitHub and app on GitLab.

## Steps

1. Run `ark merge-request open <run>`.

## Expected results

- The core MR is created with `gh`, the app MR with `glab`, and the app description has `Depends on !1`.

## Screenshot checkpoints

none: integration case on CLI output and host calls; no UI surface.
