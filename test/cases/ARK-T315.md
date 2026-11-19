---
id: ARK-T315
title: ARK-T315 a source that stops answering keeps its last good value and shows its age on the stale chip; before a first read the page says unknown
level: e2e
technique: state transition (source unread, source answered, source failing) with the age read in whole minutes on a controlled page clock
priority: medium
risk: "a source that stops answering shows nothing or an empty list, or says 'as of N s ago' the page no longer renders; before a first read the page shows an empty list instead of unknown; the age never moves, or it undercounts (3 minutes on the page clock with no push since reading `1 min` because the minute divisor changed)"
status: active
changed_by: 2026-11-15-ARK-493-1
---

## Objective

Prove that a source which answered and then fails keeps its last good value, and that the stale chip list shows its age in whole minutes, counted from the source's last good read; before the first good read the list and the agents say unknown.

## Preconditions

- Hub with project `p`, a building run, and a fake Orca and Plannotator that fail until the test writes `up` to their mode files; the test writes `down` once every source has read, so they fail again.
- The page clock is installed before the page loads: the chip's minute timer must be the clock's.

## Steps

1. Open the run page in a second tab and Home in the first.
2. Assert the list rows for `orca` and `plannotator` say `unknown` and the agents list says `unknown`, not `no live agent`.
3. Write `up` to the mode files; wait until the agent model shows and the stale chip is gone (every source has read once); write `down`; assert the agent model and the gate link still show.
4. Wait until both sources are stale again; assert the last good values stay and each list row shows an age in minutes.
5. Fast-forward the page clock 3 minutes; wait until the `orca` row shows 2 or more minutes. A push after the jump takes the age back to about 0 only because the page clock jumped and the server clock did not (the age is the server's `generated_at - read_at` plus the time since the page got the snapshot). So jump 3 minutes again only when a push arrived after the last jump and the row reads less than 2 minutes; a row that reads less than 2 minutes with no push after the jump is a miscount and fails the case. The wait fails at a 60 s timeout, never the 15 s default.

## Expected results

- Before the first read: `unknown` in the chip list and in the agents list.
- After a source fails: its last good value stays and its row shows `<N> min`, counted from the source's last good read.
- The age moves by whole minutes: 3 minutes on the page clock with no push shows 2 or more, never 0 or 1.

## Screenshot checkpoints

none: the case asserts requests, text and positions.
