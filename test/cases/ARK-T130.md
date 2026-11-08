---
id: ARK-T130
title: ARK-T130 ARK-T76 passes when the hub answers late: the 200-ticket snapshot wait and the push wait end on their event with no 10-second deadline deciding
level: integration
technique: fault injection (delayed first snapshot and delayed push after the body edit); event wait instead of deadline
priority: high
risk: "under load the 200-ticket snapshot or the push after the body edit arrives after 10 s and the test fails (2 of 5 `ark test` runs of ARK-317-1) though the hub is right"
status: active
changed_by: 2026-11-08-ARK-331-1
---

## Objective

Prove that ARK-T76 waits for the snapshot and the push by event, so a late hub does not fail it, while the payload checks stay the same.

Expected: When the hub answers late, the test shall still receive the snapshot and the push and assert the same payload sizes and fields.

## Preconditions

- Hub with 200 tickets of 3 KB; a hook (in the test) delays the first snapshot and the push after the body edit by over 10 s.

## Steps

1. Start the hub with the delay set for the first snapshot; wait on the snapshot event; assert size under 15% and the kept fields.
2. Edit one ticket body; delay the push by over 10 s; wait on the push event; assert the push is present and slim.
3. Assert no fixed 10 s deadline remains in the test.
4. If the original failure does not reproduce at base with the delay, record that in the report.
5. Run `bun test test/hub.test.ts`.

## Expected results

- The delayed runs pass with the same assertions as before.
- No 10 s deadline decides the result.

## Screenshot checkpoints

none: the case checks logic or output, not appearance.
