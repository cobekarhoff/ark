---
id: ARK-T393
title: ARK-T393 A submodule bump whose downstream worktree is missing still reads upstream branch unknown, after the repo facts are read
level: integration
technique: equivalence classes (pointer present in a control run vs worktree missing in a second run) and race ordering (assert only after the facts are read)
priority: high
risk: "a fix for ARK-468 that reads the gitlink another way (superproject index, or a default sha) turns a pointer that cannot be read into a made-up commit; or the word for a missing pointer changes or throws; or the test reads `unknown` before the repo-facts loop has published, so it passes for the wrong reason (an unread fact is `unknown` too) and would still pass if a missing pointer were reported as a commit"
status: active
changed_by: 2026-11-14-ARK-468-1
---

## Objective

Prove that when the submodule pointer really cannot be read, the bump state of the hub snapshot says `points at upstream branch unknown`, and that the `unknown` comes from the facts read (`hub/repos.ts`, `existsSync(path)`), not from the facts not being read yet.

## Preconditions

- Test in `test/hub.test.ts`, with the fixtures of ARK-T358 (`writeRepoWorkspace`, `repoRunFixture`), 3 repos, `mr` mode, no `bump.refreshed` for `web-bump`.
- Two runs in one project, same edge `service -> web` (submodule, pin `vendor/service`, bump `web-bump`):
  - control run: the `web` worktree exists and its first commit records the gitlink `0123456789abcdef...` for `vendor/service`;
  - missing run: its `web` worktree `path` in the run state points at a folder that does not exist (never created). The `web` repo of the workspace still holds the gitlink, so a reader that bypasses the worktree would find a commit.
- The facts are held back as in ARK-T358 (a `git` shim that delays `ls-tree` by 1 s), so the test fails if it does not wait.

## Steps

1. Install the delaying `git` shim, start the hub.
2. Wait for the snapshot in which both runs have their facts read: a repo of each run has `branch.ahead` not null. Do not wait for the MR state alone.
3. Read `bump_state` of the edge `web-bump` for the control run and for the missing run.

## Expected results

- The control run reads `points at upstream branch 01234567`: this proves the facts were read and a pointer can be found.
- The missing run reads `points at upstream branch unknown`: if the pointer cannot be read, then the bump state shall say `unknown`.
- No sha, no empty value and no throw for the missing run; the run stays in the snapshot with its other repos' states.

## Screenshot checkpoints

none: the proof is snapshot data, not a view.
