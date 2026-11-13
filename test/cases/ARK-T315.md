---
id: ARK-T315
title: ARK-T315 ARK-277-AC11 a source that stops answering keeps its last good value and shows its age on the stale chip; before a first read the page says unknown
level: e2e
technique: state transition (source unread, source answered, source failing) with the age read in whole minutes on a controlled page clock
priority: medium
risk: "a source that stops answering shows nothing or an empty list, or says 'as of N s ago' the page no longer renders; before a first read the page shows an empty list instead of unknown; the age never moves"
status: active
changed_by: 2026-11-12-ARK-335-1
---

## Objective

Prove that a source which answered and then fails keeps its last good value, and that the stale chip list shows its age in whole minutes; before the first good read the list and the agents say unknown. Converted on touch from ARK-277-AC11 (per-source labels became one chip, ARK-335).

## Preconditions

- Hub with project `p`, a building run, and a fake Orca and Plannotator that fail until a mode file says `twice`.

## Steps

1. Open the run page in a second tab and Home in the first; open the stale chip list.
2. Assert the list rows for `orca` and `plannotator` say `unknown` and the agents list says `unknown`, not `no live agent`.
3. Write the mode files so each source answers twice, then fails; assert the agent model and the gate link show.
4. Wait until both sources are stale again; assert the last good values stay and each list row shows an age in minutes.
5. Install the page clock and fast-forward 3 minutes; assert the `orca` row shows 2 or more minutes.

## Expected results

- Before the first read: `unknown` in the chip list and in the agents list.
- After a source fails: its last good value stays and its row shows `<N> min`.
- The age moves by whole minutes.

## Screenshot checkpoints

none: the case asserts requests, text and positions.
