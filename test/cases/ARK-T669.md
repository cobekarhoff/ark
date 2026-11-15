---
id: ARK-T669
title: "ARK-T669 `ark chief state` prints the count of unread messages of every type to Master Chief's Run and the minute age of the oldest, without marking any read, and says unavailable when a read fails"
level: integration
technique: equivalence classes (0 unread, 3 unread, failed read) with boundaries on read 1 rows, message types, the 59/60/61 minute step with whole-minute flooring, the 20-row default page against more than 20 rows, plus a state check that nothing was consumed
priority: high
risk: "the line counts only question and escalation, so worker_done, status and heartbeat messages that sit unread stay invisible; or it counts rows with read 1 and shows an old, already read message as the oldest; or it reuses `elapsed()` and prints `1h` for 95 minutes; or it reads with `check` and marks the messages read, so the stuck inbox is emptied by looking at it; or `check --peek` is refused for a caller that is not the coordinator and the line is always unavailable for a lead, Cobe's shell or a watchdog; or the reader drops `--limit` so Orca's default page of 20 rows hides every unread message past the newest 20 (the oldest unread, and so the age and the count, are wrong exactly when the inbox is stuck under status and heartbeat rows); or a failed run-list, missing Master Chief Run or failed inbox prints `0` and reads as an empty inbox"
status: active
changed_by: 2026-11-14-ARK-499-1
---

## Objective

Prove that `ark chief state --project <p>` shows how many messages to Master Chief's Orca Run are unread, of every type, and how old the oldest is, and that reading them leaves every message unread. Proves AC1.

## Preconditions

- Test in `test/chief.test.ts`, same temporary `ARK_HOME` and fake `orca` as ARK-T115. The fake answers `orchestration inbox --terminal run:<chief run id> --full --json` with rows that carry `read`, `created_at`, `to_handle` and `type`, newest first. The fake honours `--limit`: it returns at most that many rows, and 20 rows when the flag is absent, as real Orca does (`orca orchestration inbox --json` returns 20). The fake also models consumption: a `check` without `--peek` flips `read` to 1 in its store, and `check --peek` is refused as `worker_cannot_coordinate_own_run`, as real Orca refuses a caller that is not the coordinator of that Run.
- The clock is frozen for the case. `ark()` spawns `bun cli/ark.ts` with `process.env` (`test/helpers.ts:148-150`), so the case sets `ARK_NOW` to `2026-11-04T12:00:00Z` (the instant `useFrozenClock` sets, `test/helpers.ts:323`) in its own body and restores it after; a file-level `beforeAll` is not enough, because `closeRunAt` of `test/chief.test.ts:860-874` deletes `ARK_NOW`. Each row `created_at` is that instant minus the row's age (`inboxRow` of `test/chief.test.ts` computes it from the same instant, not with `isoAgo`, which reads `ARK_NOW` when it is called), so it is exact against that instant. The reader ages a row by `now()` of `cli/clock.ts`, the clock `ARK_NOW` freezes, and never by `Date.now()` as `elapsed()` of `cli/chief.ts:55` does. The age unit is whole minutes, floored: 15 min 59 s reads `15 min`.
- Master Chief's Run is listed by `run-list` with the objective `Master Chief: <project> tickets`. The other existing `chief state` cases answer `inbox` with an empty row list, so their sections stay as they are.

## Steps

1. Zero case: inbox rows are one row with `read` 1 only (any age), or no rows. Run `ark chief state --project <p>` and read the unread line.
2. Three unread: rows are `question` 95 min old, `worker_done` 40 min old, `status` 2 min old, all `read` 0, and one `escalation` 300 min old with `read` 1. Run the command and read the line. Then read the fake's store.
3. Minute step: one unread row 59 min old, then one 60 min old, then one 61 min old, one run each. Read the line each time.
4. More rows than the default page: 24 rows newest first. Rows 1 to 20 are `read` 1 `status` and `heartbeat` rows (1 to 20 min old). Rows 21 to 23 are `read` 0: a `status` 60 min old, a `worker_done` 90 min old, a `question` 200 min old (row 24, the oldest overall, is a `read` 1 `escalation` 400 min old). Run the command and read the line. The reader passes `--limit 10000` (`inboxLimit` of `hub/sources.ts`), so the fake returns all 24.
5. Floored minutes: one unread row 95 min 59 s old (`created_at` is the frozen instant minus `95 * 60_000 + 59_000` ms), read against the frozen instant. Read the line.
6. Failed read, three ways, one run each: (a) `run-list` fails; (b) `run-list` answers with no Master Chief Run for the project; (c) `inbox` fails with a message. Read the unread line and the exit code.

## Expected results

- Step 1: the line reads `unread for Master Chief: 0`, with no oldest age and no `unavailable`.
- Step 2: the line reads `unread for Master Chief: 3, oldest 95 min`. The `read` 1 row of 300 min is not counted and is not the oldest. The count includes the `worker_done` and the `status` row, so every type counts. After the command, the fake's store still holds the same three rows with `read` 0 and the fourth with `read` 1: no message is marked read. The command never reaches the fake's consuming `check` path.
- Step 3: the age is `59 min`, `60 min` and `61 min`: minute precision, never `1h`.
- Step 4: the line reads `unread for Master Chief: 3, oldest 200 min`. All three unread rows sit past the fake's default 20 rows, so a reader that omits `--limit` prints `0` here and fails.
- Step 5: the age is `95 min`, not `96 min` and not `1h`.
- Step 6: (a) and (c) print `unavailable: orca orchestration <verb> failed: <reason>` in the form of the other sections, with the verb that failed (`run-list` or `inbox`) and the reason; (b) prints the existing no Master Chief Run text of the other sections. None of the three prints `0` or `none`. The command exits `0` with empty stderr in each of (a), (b) and (c), as it does for an unavailable Orca section (ARK-244-AC1), and the other sections still print.
- The sections other than the unread line are as in ARK-T115, so the new line adds no change to them.

## Screenshot checkpoints

none: integration case on CLI output; no UI surface.
