---
id: ARK-T355
title: "ARK-T355 the Runs page switches to Conversation and draws the metro map of Master Chief, 4 runs, 2 questions with waiting bands and 1 answer, and a run click opens its Conversation tab"
level: e2e
technique: "equivalence classes of run (closed, open, with question, answered/unanswered) with state transition of the List/Conversation switch"
priority: high
risk: "List stops being the default or loses its test ids; a run line does not leave at its start or return at its close; an open run is drawn closed; a question has no thick spur or no waiting band; an unanswered question's band stops early or runs past its run's close; a question with no `delivered` time starts its band at the wrong place; a human answer has no person marker; another project's run is drawn; the 'In order, not to scale' label is missing; a run click opens the wrong run or tab"
status: active
changed_by: 2026-11-13-ARK-346-1
---

## Objective

Prove AC1: the List and Conversation switch, and the metro map drawn from `GET /api/conversation`.

## Preconditions

- Real hub page; `/api/conversation` stubbed with a project-shaped reply (`ProjectAnswer`), reusing the route stub of ARK-T340 to ARK-T345.
- The shared fixture below: 4 runs (A, B, C in the scoped project, D in another), 3 questions (Q1 answered, Q2 and Q3 unanswered, Q3 with `delivered: null`), 1 human answer.
- Viewport 1440x900, light and dark.

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

1. Open Runs without a mode: List is selected and the existing Board, graph and closed band test ids are present; the Conversation map is absent.
2. Press Conversation: the map shows, labelled 'In order, not to scale', a Master Chief line and one line for each of the 3 runs of the scoped project (run D is not drawn).
3. Check each line: runs A (08:00 to 09:00) and B (08:30 to 10:55) leave the central line at their start and return at their close; run C (08:05) leaves and stays open to the window end 11:00.
4. Check message beads: every message to or from Master Chief touches the central line; Q1, Q2 and Q3 are thick spurs; other messages are thin.
5. Check bands: Q1 has a hatched 'waiting on you' band from 08:10 to 08:25; Q2's band runs from 08:40 and Q3 (`delivered: null`) starts its band at its sent time 10:50; neither has an answer, so both end where B closes (10:55), not at the window end, and are not open. Scrub to 09:30: B is open, so Q2's band is open and ends at the scrubber; Q3 has no band yet.
6. Check the person marker: exactly 1 on the central line at 08:25.
7. Click the line of run B: the page opens run B's Conversation tab. Go back, click the badge of run A: run A's tab opens.
8. Press List: the List content is back with its test ids.

## Expected results

- List is the default and unchanged; Conversation is a mode of the same page.
- 3 run lines for the scoped project (run D absent); positions follow the start and close times; run C is open.
- 3 thick spurs, 3 hatched bands (Q2's from 08:40 and Q3's from 10:50, both ending at B's close 10:55, not open; at 09:30 Q2's band is open), 1 person marker at 08:25.
- The label 'In order, not to scale' is visible.
- A run line or badge click opens that run's Conversation tab, by `runHref(run, "conversation")`.
- Bounding boxes of lines, spurs, bands and the marker are non-zero and inside the map, and `document.elementFromPoint` at a line's centre returns that line (no overlay hides it).

## Screenshot checkpoints

The map with 3 drawn runs, 3 spurs, 3 bands and the person marker (dark and light); the List default.
