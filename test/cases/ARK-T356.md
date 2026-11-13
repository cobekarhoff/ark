---
id: ARK-T356
title: "ARK-T356 the To scale strip is the replay scrubber: moving it changes the shown count, play runs at 10x, 60x and 600x with trains and message dots, and reduced motion keeps the scrubber but stops motion"
level: e2e
technique: "boundary values (count at two scrubber times) with equivalence classes of speed and motion preference"
priority: high
risk: "the strip is not on a true time axis (equal gaps for unequal times); the scrubber does not set the playhead, so the count stays; the count includes messages after the playhead; a speed button gives the wrong rate; no train dot on a live line or no message dot to Master Chief; a train shows on a closed run; under reduced motion something still animates or the scrubber stops working; the message with no time (m9) is drawn, counted, or breaks the axis"
status: active
changed_by: 2026-11-13-ARK-346-1
---

## Objective

Prove AC2: the 'To scale' strip (density, one lane per run, human answers), the replay player controls, the moving trains and message dots, and the reduced-motion rule.

## Preconditions

- The shared fixture below, unchanged from ARK-T355.
- Controllable clock (`page.clock`) or scrubber-driven checks; no wall-clock waits.
- Viewport 1440x900; a second context with `reducedMotion: 'reduce'`.

## Shared fixture (ARK-T355 to ARK-T357)

Base `2026-11-12T08:00Z`; times are UTC, never `ago()`. Window end is 11:30 (B's close, the latest known time).

| Run | Project | Start | Close | Steps                                           |
| --- | ------- | ----- | ----- | ----------------------------------------------- |
| A   | scoped  | 08:00 | 09:00 | A1 08:00-09:00                                  |
| B   | scoped  | 08:30 | 11:30 | B1 08:30-11:30                                  |
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

1. Open Conversation: the strip is labelled 'To scale'; it has density, one lane for each run, the human answer, and the player (play/pause, 10x, 60x, 600x).
2. Check the time axis: the strip holds exactly 8 message ticks (m1 to m8; m9 has no time and has no tick). Their x is in proportion to time: the m5 to m6 gap (120 min) is about 40 times the m1 to m2 gap (3 min), within 5%, unlike the map above, where beads are in order.
3. Set the scrubber to T1 (08:10, after m1 to m3): the Now count shows 3 messages; the playhead is drawn on both the strip and the map. Set it to T2 (11:00, after m1 to m8): the count shows 8, not 9, because m9 has no time and is never counted. Set it back to T1: 3.
4. Check m9: at T2 and at the window end the count stays 8, no tick or feed row for m9 is shown on the strip, and the axis (other ticks' x) is the same as without m9.
5. Press play at 600x, advance the clock 1 s: the playhead moved about 600 s; at 60x and 10x it moves about 60 s and 10 s. Press pause: it stops.
6. Start play at T3 (09:30): B and C each have a train dot on their line, A (closed 09:00) has none; a message dot moves to or from Master Chief when a message is sent.
7. Trigger a live snapshot change during play: the playhead and speed stay.
8. Reopen with reduced motion and press play: no CSS animation or transition is running on trains or dots (`getAnimations()` is empty), yet the scrubber sets the playhead and the count (3 at T1, 8 at T2).

## Expected results

- The count is 3 at T1, 8 at T2 (m9 excluded), and 3 again after seek back; the strip has 8 ticks.
- The strip positions follow true time; the map above stays in order.
- Rates are 10x, 60x, 600x; pause stops; a poll does not reset the replay.
- Trains only on live runs (B and C at T3, not A); message dots only while a message is in flight.
- Under reduced motion no animation runs and the scrubber works.

## Screenshot checkpoints

The strip at T1 with the playhead on both views (dark); the strip under reduced motion.
