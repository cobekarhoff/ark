---
id: ARK-T370
title: ARK-T370 Home counts only the chosen project in its tiles, lists, cost and header, and the provider limit says all projects, for All, each project and after a reload
level: e2e
technique: equivalence classes of project filter (All, alpha, beta) crossed with reload; the limit is the same in each
priority: high
risk: "the project filter leaves another project's runs, cost or badge in a tile, list or the header, loses the filter on reload, or presents the account-wide provider limit as one project's"
status: active
changed_by: 2026-11-14-ARK-499-1
---

## Objective

Prove that the project filter of Home narrows the tiles, lists, cost and the needs-you badge to the chosen project, keeps it after a reload, and always labels the provider limit "all projects".

Expected: For All, each project and after a reload, Home shall count only the chosen project, and the usage limit shall name all projects.

## Preconditions

- Two projects, alpha and beta, each with 3 runs and one stuck, one review, one gate and one waiting item; cost $1.25 for alpha and $2.50 for beta.
- The hub and the page run on the frozen instant.

## Steps

1. For each of `` (All), `?project=alpha`, `?project=beta`, with and without a reload: open Home.
2. Read the `usage`, `needs-me`, `reviews`, `stuck`, `runs` and `cost` tiles, the counts of the `stuck`, `review`, `gate`, `waiting` and `run` rows, `nav-cost`, the badge and the last `cost-day`.
3. Read the usage tile, `usage-window` and `nav-usage`.
4. Read the `chief-unread` tile (ARK-499). Each project has its own Master Chief Run: alpha has 2 unread rows (oldest 40 min), beta has 3 unread rows (oldest 95 min). Then make beta's inbox read fail and read the tile for All, alpha and beta again.
5. Remove beta's Master Chief Run from `run-list` (its unread rows stay in the fake) and read the tile for All, beta and alpha, and the sources of the stale chip. Then remove alpha's too and read the tile for All.

## Expected results

- All: 2 of each list, 6 runs, $3.75, "4 need you"; alpha: 1, 3 runs, $1.25, "2 need you"; beta: 1, 3 runs, $2.50, "2 need you".
- The same result after reload.
- `chief-unread`: All shows the sum `5` and `oldest 95 min` (the oldest unread across projects) with the warning; alpha shows `2` and `oldest 40 min` with the warning; beta shows `3` and `oldest 95 min` with the warning; the same after reload. No project shows another's count.
- With beta's read failed: All shows `?` and `unavailable` (never a partial sum of `2`), alpha still shows `2` and `oldest 40 min`, beta shows `?` and `unavailable`.
- With beta having no Master Chief Run: All shows `2` and `oldest 40 min` (the sum of the projects that have one, beta's rows not counted); beta shows `-` and `no Master Chief Run`, with no warning tone, not `0` and not `unavailable`; alpha shows `2`; the stale chip does not name `chiefUnread`. With no project having one, All shows `-` and `no Master Chief Run`, not `unavailable`, and the chip does not name `chiefUnread`.
- The usage tile reads 82% and each of the three places says "all projects" in every case.

## Screenshot checkpoints

none: the case checks text, counts and attributes, not appearance.
