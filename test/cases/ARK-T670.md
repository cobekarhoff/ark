---
id: ARK-T670
title: "ARK-T670 The hub Home shows the same count and age of unread messages to Master Chief, marks it as a warning in words and tone only when the oldest is 16 whole minutes or more, and shows unavailable when the read fails"
level: e2e
technique: boundary values (14, 15 min 59 s and 16 min on whole minutes, floored) with equivalence classes (0 unread, unread under, unread over, failed read)
priority: high
risk: "the tile shows no warning at 95 min, or warns at 15 min or at 15 min 59 s (the threshold is whole minutes, floored: 16 min warns; Cortana's entry says 10 and a copy of it fails the 12 min row); the warning is colour only, so a reader without colour never sees it; the count or age differs from the CLI line (`1 h 35 min` instead of `95 min`, or only question and escalation counted like the hub's wait filter, or the reader omits `--limit` and misses the unread rows past Orca's default 20); a failing inbox reads as `0` or turns the whole `queue` slot stale; the warning words are clipped or wrapped to one word per line at 1024 px"
status: active
changed_by: 2026-11-14-ARK-499-1
---

## Objective

Prove that the hub Home shows, in one tile, the count of unread messages to Master Chief's Run and the minute age of the oldest, the same values as `ark chief state`, and that the tile is a warning when and only when the oldest is 16 whole minutes or more. Proves AC2. The scope of the tile for All projects and each project is owned by ARK-T370; the 7-tile layout by ARK-T227 and ARK-T262.

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts`, with the fixtures of the other Home specs (`test/hub-fixtures.ts`), viewport 1440 px wide (set in the test), and for step 6 1024 px.
- The fake `orca` of the hub answers `orchestration inbox --terminal run:<chief run id> --limit <n> --full --json` with rows of `read`, `created_at`, `type`; it honours `--limit` and answers 20 rows without it. The hub reader passes `--limit 10000` (`inboxLimit` of `hub/sources.ts`). The hub runs with every source loop at 300 ms. The test rewrites the fake's state file while the hub runs (`writeFakeToolState`), so each step reaches the tile through the next pushed snapshot, not through a page reload; the test reads the tile with a retrying expectation until it shows the step's row set. The fake answers `inbox --limit 200` as before.
- One project `p` exists with its Master Chief Run, and the page opens `#/?project=p`; its unread rows are the rows of each step.
- The age unit is whole minutes, floored, as the CLI. The page ages a time as the server's `generated_at` minus the time plus the seconds since it received the snapshot (`useAge`, `hub/page/store.tsx:153-162`). The server clock is the `ARK_NOW` that `useCleanup` freezes (`test/pw/helpers.ts:270-275`; `generated_at` is `now()` of `cli/clock.ts`, `hub/snapshot.ts:553`); the page clock is `page.clock.setFixedTime(testNow())`, so the seconds since receipt are 0. Each row `created_at` is `isoAgo(<age>)` of `test/pw/helpers.ts:303`, derived from `testNow()`: a row `15 min 59 s` old reads `15 min` and shows no warning, a row `16 min` old warns.

## Steps

1. Rows: none unread (one `read` 1 row 300 min old). Read the `chief-unread` tile.
2. Rows: 3 `read` 0 rows (a `worker_done` 12 min old, a `status` 5 min old, a `question` 1 min old). Wait for the tile to show them and read it.
3. Rows: 3 `read` 0 rows (a `question` 95 min old, a `worker_done` 40 min old, a `status` 2 min old) and one `read` 1 `escalation` 300 min old. Wait for the tile and read it.
4. Boundary: one `read` 0 row 14 min old, then 15 min 59 s old, then 16 min old, one new row set each. Read the tile each time.
5. Make the inbox read of project `p` fail. Read the tile and the other Home tiles.
6. At 1024 px, with 2 `read` 0 rows (a `worker_done` 40 min old and a `question` 95 min old), read the words of the tile.
7. More than 20 rows: 22 rows newest first, 20 `read` 1 `status` rows, then 2 `read` 0 rows (a `question` 30 min old and a `worker_done` 90 min old). Wait for the tile and read it.

## Expected results

- Step 1: the tile `chief-unread`, labelled `Chief unread`, shows `0` and `nothing unread`, with no warning tone and no `older than 15 min`.
- Step 2: the tile shows `3` and `oldest 12 min`; it has no warning tone and no `older than 15 min`.
- Step 3: the tile shows `3` and `oldest 95 min`, the same count and age as the CLI line `unread for Master Chief: 3, oldest 95 min` of ARK-T669; the `read` 1 row is not counted. It has the warning tone and the words `older than 15 min` in its text, so the warning is readable without colour.
- Step 4: 14 min and 15 min 59 s (shown `15 min`) show no warning; 16 min shows the warning. The tile is a warning only when the oldest is 16 whole minutes or more.
- Step 5: the tile shows `?` and `unavailable: inbox read failed`, with no tone and no `0`. The other Home tiles still show their values and the page does not mark the `queue` slot stale.
- Step 6: at 1024 px the warning words `older than 15 min` and `oldest 95 min` stay readable: not clipped and not one word per line (the tile's `scrollWidth` does not exceed its `clientWidth`). The row layout is not asserted here.
- Step 7: the tile shows `2` and `oldest 90 min`: both unread rows sit past Orca's default 20 rows and are counted.

## Screenshot checkpoints

- Step 3 at 1440 px: the Home tile row with the warning tile (`3`, `oldest 95 min`, `older than 15 min`).
- Step 6 at 1024 px: the warning tile.
