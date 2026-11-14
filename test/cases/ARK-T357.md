---
id: ARK-T357
title: "ARK-T357 the Now panel follows the scrubber, a type chip, a run filter and the search filter the map and strip, a click opens the shared inspector, and the map has Fit, 100% and Full screen"
level: e2e
technique: "equivalence classes (type chip, run filter, text) with boundary values of the scrubber time for the Now panel"
priority: high
risk: "the Now panel shows counts or live runs of the wrong time (all-time totals, not the playhead); a run in its gap does not read 'between steps'; a filter hides the map but not the strip (or the other way); search matches a body the project reply does not hold; a click on a marker, station, person or line opens nothing, the wrong message or the wrong run's inspector, or breaks on a 404 body; the Full screen copy duplicates test ids or hides the map; controls act on a wrong scale"
status: active
changed_by: 2026-11-13-ARK-346-1
---

## Objective

Prove AC3: the Now panel at the scrubber time, the type chips, run filter and search, the shared inspector from all four click targets, and the Fit, 100% and Full screen controls.

## Preconditions

- The shared fixture below, unchanged from ARK-T355 and ARK-T356. `/api/conversation/message/m5` is stubbed with its body (which holds "plover"); `/api/conversation/message/m6` returns 404.
- Viewport 1440x900.

## Shared fixture (ARK-T355 to ARK-T357)

Base `2026-11-12T08:00Z`; times are UTC, never `ago()`. Window end is 11:00 (C's last message m8, the latest known time). B closes earlier, at 10:55.

| Run | Project | Start | Close | Steps                                           |
| --- | ------- | ----- | ----- | ----------------------------------------------- |
| A   | scoped  | 08:00 | 09:00 | A1 08:00-09:00                                  |
| B   | scoped  | 08:30 | 10:55 | B1 08:30-10:55                                  |
| C   | scoped  | 08:05 | open  | C1 08:05-08:50, C2 10:30-open (gap 08:50-10:30) |
| D   | other   | 08:00 | 09:00 | not drawn, not counted                          |

| Message | Run | Time               | From to | Type        | Subject | Note                                                            |
| ------- | --- | ------------------ | ------- | ----------- | ------- | --------------------------------------------------------------- |
| m1      | A   | 08:02              | A to MC | status      | alder   |                                                                 |
| m2      | C   | 08:05              | C to MC | status      | birch   |                                                                 |
| m3      | A   | 08:09              | A to MC | question Q1 | cedar   | delivered 08:10, answered by human at 08:25                     |
| m4      | A   | 08:25              | MC to A | answer      | dogwood | the 1 human answer, with its gate                               |
| m5      | B   | 08:40              | B to MC | question Q2 | elm     | delivered 08:40, never answered; body holds the word "plover"   |
| m6      | C   | 10:40              | C to MC | status      | fir     | `/api/conversation/message/m6` returns 404; m5 returns its body |
| m7      | B   | 10:50              | B to MC | question Q3 | ginkgo  | `delivered: null`, never answered                               |
| m8      | C   | 11:00              | C to MC | status      | hazel   |                                                                 |
| m9      | C   | `created_at: null` | C to MC | status      | juniper | no usable time (`sentAt` returns NaN)                           |
| m10     | D   | 08:20              | D to MC | status      | kite    | other project, never counted                                    |

Named times: T1 = 08:10, T2 = 11:00, T3 = 09:30, T4 = 08:20, T5 = 08:01.
Rule for m9: with no time it is dropped from the strip ticks, from the feed position and from every count (`sentAt(m9) <= playhead` is false at any playhead). So the strip holds 8 ticks, and the count is 3 at T1 and 8 at T2 (m1 to m8; m9 never counts).

## Steps

1. Scrub to T3 (09:30): the Now panel shows exactly 2 live runs, B (current step B1) and C (reads 'between steps', since C1 ended 08:50 and C2 starts 10:30). A run between steps counts as live; A (closed 09:00) is not counted. It shows 5 messages (m1 to m5) and 1 human answer. The latest messages are listed newest first: m5, m4, m3, m2, m1; none after 09:30.
2. Scrub to T4 (08:20): 2 live runs (A and C, both in a step, none 'between steps'), 3 messages, 0 human answers. Scrub to T5 (08:01): 1 live run (A), 0 messages, 0 answers and no latest messages. Scrub to T2 (11:00): 1 live run (C in C2; B closed at 10:55), 8 messages, 1 answer.
3. Select the 'question' type chip: the map and the strip show only m3, m5 and m7 (the fixture has no escalation); the other beads leave both; clear the chip: all return.
4. Select run B in the run filter: only B's line and lane stay on both the map and the strip, with m5, m7 as its only beads; Master Chief's line stays.
5. Type "elm" (the subject of m5) into search: only m5 stays on both views. Type "plover" (in m5's body only): nothing matches (body text is not in the project reply).
6. Click a message marker, a station, the person marker and a run line, one after another: the shared inspector opens each time with the right content (the message m5 with its body; the step C1; the human answer m4 and its gate; run B), for the owning run. Click m6 (404 body): the inspector shows 'not available' text, not an error page, and `sessions === null` does not break it.
7. Check the controls: Fit shows the whole map; 100% sets the scale to 1; Full screen shows the map in a fixed layer with test ids unique (one copy); leave Full screen restores it. The inspector can still be opened in Full screen.
8. With `document.elementFromPoint`, check that at a marker's centre the topmost element is the marker (the Now panel, the sticky labels or the full-screen layer do not cover it).

## Expected results

- The Now panel equals the numbers of the scrubber time, not the totals of the window.
- A filter changes the map and the strip the same way; search uses subjects only.
- All four targets open the shared inspector with the right owner; a 404 is handled.
- Fit, 100% and Full screen work, with one copy of the map's test ids.
- No overlay hides a marker.

## Screenshot checkpoints

The Now panel with the inspector open on a message (dark); a filtered map and strip; Full screen.
