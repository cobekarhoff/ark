---
id: ARK-T275
title: ARK-T275 the chips filter the list into messages, tools, thinking and errors with counts of the loaded entries, combine as toggles, j and k move through the visible entries only, and r switches Rendered and Raw and the choice stays when the selection moves
level: e2e
technique: equivalence classes of chip combinations (none, one, two, all, errors alone, errors with tools), boundary values of the selection (first, last visible), state transition (Rendered, Raw, selection move)
priority: high
risk: "a chip count is wrong or counts entries of another kind; the errors chip shows non-failed calls or overrides the other chips instead of combining; the count claims to cover the whole file when only loaded pages count; j or k selects a hidden entry, runs past the ends or wraps, or the counter counts hidden entries; r resets when the selection moves; keys fire while typing in an input or with ctrl or meta (browser reload, find); the key handler stays after leaving the page"
status: active
changed_by: 2026-11-12-ARK-324-1
---

## Objective

Prove chips, j, k and r. Serves ARK-324/AC5. Settled: chips are toggles that combine; the errors chip shows only failed calls; chip counts and the entry counter cover the entries loaded so far and say so.

Expected: When chips are on, the system shall show only the entries of the toggled kinds (the errors chip only failed tool calls); when j or k is pressed, the system shall move the selection through the visible entries and count only those; when r is pressed, the system shall switch the inspector between Rendered and Raw and keep the choice when the selection moves.

## Preconditions

- Hub playwright fixture, one omp step session of known counts: 4 messages (user and assistant), 6 tool calls of which 2 fail, 3 thinking blocks, so messages 4, tools 6, thinking 3, errors 2.
- A second session file of 250 entries (2 pages) with 3 failed calls in the second page.
- A message with markdown (`**bold**`) so Rendered and Raw differ; a tool call with JSON arguments.

## Steps

1. Open the transcript. Read the four chips with their counts and the entry counter.
2. Click each chip alone; read the visible rows and the counter; click it again.
3. Click errors alone; then errors with tools; then errors with messages; then all four.
4. With the tools chip on, press j until the last visible entry, then j once more; press k back to the first, and k once more.
5. Read the selection and the counter on each press; check no hidden entry was selected.
6. Select the message with markdown, press r, read the inspector; press j to a tool call, then k back; read the mode.
7. Type `j`, `k` and `r` into an input of the page (the session switcher or a search field if present); press ctrl+r and meta+j.
8. Open the 250-entry file. Read the chip counts and the text next to the counter before and after Load more; toggle errors.
9. Leave to the Roadmap, press j once.

## Expected results

- Counts are messages 4, tools 6, thinking 3, errors 2; the counter shows all 13 entries. The label says the counts cover the loaded entries.
- Each chip alone shows only its kind; the errors chip alone shows exactly the 2 failed calls; errors with tools shows the 6 tools (failed ones included); errors with messages shows 4 messages and 2 failed calls; all four shows everything; none on shows all.
- j and k visit only visible rows in order; at the first or last visible entry the selection stays; the counter reads `n of <visible>` where the total is the visible count.
- r toggles Rendered to Raw (the markdown shows as `**bold**` literally in Raw) and Raw stays after j and k, for message and tool call alike; r again returns to Rendered.
- Keys typed into an input change nothing; ctrl+r and meta+j do not move the selection or the mode.
- On the 250-entry file the counts after page 1 cover 200 entries and say so; after Load more they cover 250; errors then show 3 and the counter agrees.
- On the Roadmap one j moves the Roadmap selection by one, and the transcript handler no longer acts.

## Screenshot checkpoints

`checkpoint(page, "chips-all")`, `checkpoint(page, "chips-errors")` and `checkpoint(page, "inspector-raw")`.
