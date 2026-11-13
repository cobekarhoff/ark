---
id: ARK-T345
title: "ARK-T345 the replay plays at 600x, moves the playhead, animates arrows, dims the future, and the feed shows only the messages up to the playhead"
level: integration
technique: "boundary values (feed count at two playhead times) with equivalence classes of speed and motion preference"
priority: high
risk: "the feed shows messages after the playhead; the speed buttons give the wrong rate; the scrubber does not set the playhead; replay state resets on a live poll; under reduced motion something still animates or the scrubber stops working"
status: active
changed_by: 2026-11-13-ARK-345-1
---

## Objective

Prove the AC5 replay: play, pause, 10x, 60x, 600x, scrubber, playhead, arrows, dimmed future, feed limited to the playhead, and reduced motion.

## Preconditions

- A fixture run with messages at known times (for example 3 messages in the first hour and 5 more in the second).
- A controllable clock (`page.clock`) or scrubber-driven checks, not wall-clock waits.
- Viewport 1440x900; second run with `reducedMotion: 'reduce'`.

## Steps

1. Open the Conversation tab; the player shows play/pause, 10x, 60x, 600x and the scrubber.
2. Select 600x and press play; advance the clock to the first playhead time T1 (after 3 messages): the playhead has moved, an arrow animates for a newly sent message, later ticks are dimmed, and the feed shows 3 messages.
3. Advance to T2 (after 8 messages): the feed shows 8. Press pause: the playhead stops after the clock advances.
4. Select 10x and 60x: the playhead advances at each rate (10x and 60x of the fixture time per clock second).
5. Drag the scrubber back to T1: the feed shows 3 again.
6. Trigger a live snapshot change during replay: the playhead and speed stay.
7. Reopen with `prefers-reduced-motion: reduce`: press play; no arrow animation runs (no running CSS animation or transition on arrows), yet the scrubber still sets the playhead and the feed count.

## Expected results

- The feed count is 3 at T1 and 8 at T2; the scrubber back to T1 gives 3.
- The playhead moves only while playing; the future is dimmed; arrows animate as messages are sent.
- 10x, 60x and 600x move the playhead at their rates; a poll does not reset the replay.
- Under reduced motion nothing animates and the scrubber and feed count still work.

## Screenshot checkpoints

Replay mid-run at 600x (dark) with dimmed future; the reduced-motion player.
