---
id: ARK-T252
title: ARK-T252 retro lists commits after MR open as sync commits and fix commits apart
level: integration
technique: equivalence classes (merge from base branch, merge of another branch, ordinary commit, commit before open) and boundary (merge commit with custom message)
priority: high
risk: retro counts a merge from the base branch as rework, or counts a real fix as a sync, so metrics.json overstates or hides how much the human fixed after the MR opened (11 of 12 PRs with later commits had only merges from main)
status: active
changed_by: 2026-11-11-ARK-377-1
---

## Objective

Prove that `metrics.json` splits the commits after the MR opened into `mr_sync_commits` (merges from the base branch) and `mr_fix_commits` (all others), by whether a merge's second parent is in the base branch's history, and not by commit message or parent count alone, for both GitHub and GitLab. Serves ARK-377/AC2.

Expected: When ark retro counts the commits after a merge request opened, the system shall list merges from the base branch as sync commits and every other commit as fix commits, apart.

## Preconditions

- Same fixture as ARK-T251 (worktree absent, fake `gh` and `glab` in `PATH`, one GitHub MR and one GitLab MR), with the base branch `main`.
- Base ancestry fixture: the fake answers the base-branch history query (`gh api repos/acme/web/commits?sha=main...`, `glab api projects/acme%2Fapi/repository/commits?ref_name=main...`) with the shas `aaa111`, `aaa222`, `aaa333` (the history of `main`). Shas `bbb111` and `ccc111` are not in it.
- GitHub MR commits (fake answer of the commits API with `sha` and `parents`): before open: `g0` (parents `[g00]`, ordinary). After open, in order: `g1` (parents `[g0, aaa222]`, message `bring in latest`: merge of `main`), `g2` (parents `[g1, bbb111]`, message `Merge feature/x`: merge of another branch, 2 parents, second parent not in `main`), `g3` (parents `[g2]`), `g4` (parents `[g3]`).
- GitLab MR commits (with `parent_ids`): after open: `l1` (parent_ids `[l0, aaa333]`, title `Merge branch 'main' into ...`), `l2` (parent_ids `[l1]`), and `l3` (parent_ids `[l2, ccc111]`, title `Merge branch 'main' into topic`: a message that claims `main` but whose second parent is not in `main`'s history).
- A second run in the same fixture whose later commits are 2 merges whose second parents are `aaa111` and `aaa222` (in `main`'s history) and nothing else.

## Steps

1. Build the fixture as in ARK-T251, with the commit lists above.
2. Run `ark retro <run>`.
3. Read `human_intervention` in `<run folder>/metrics.json`.
4. Repeat for the second run.

## Expected results

- `mr_sync_commits` is 2: `g1` and `l1`. Both have 2 parents and a second parent in `main`'s history.
- `mr_fix_commits` is 5: `g2` (2 parents, second parent not in `main`: parent count alone does not make it a sync), `g3`, `g4`, `l2`, `l3` (message says `main`, second parent is not in `main`: classified by ancestry, not message).
- `mr_commits_after_open` is 7, the sum of both. `g0` (before open) is in no count.
- Second run: `mr_sync_commits` is 2, `mr_fix_commits` is 0, `mr_commits_after_open` is 2.

## Screenshot checkpoints

None. The surface is a JSON file; no screenshot applies.
