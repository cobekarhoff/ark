---
id: ARK-T133
title: ARK-T133 ARK-277-AC4 the page sends no request but its first load and one event stream, and an appended event shows on Home within 5 s, while 30 s of silence on each view passes on a controlled clock
level: e2e
technique: state transition (first load, then each view); controlled page clock instead of a 30-second wait
priority: high
risk: "a view polls the hub after the first load, or opens a second event stream, or an appended event does not reach Home without a page request; or the 30-second silence check waits in real time"
status: active
changed_by: 2026-11-12-ARK-335-1
---

## Objective

Prove that the hub page loads once, opens one event stream, and then reads nothing on Home, Runs or Roadmap, while an appended event still reaches Home.

Expected: When the page is open, it shall send no request after its first load and one event stream, and an appended event shall show on Home within 5 s.

## Preconditions

- A hub with one building run and two backlog tickets, and a fake orca that answers for the run.
- The Playwright page records every request.

## Steps

1. Open the hub; wait for the run card and no stale chip.
2. Assert the requests are `/`, `/assets/*` and exactly one `/events`.
3. Install the page clock. For Home, Runs and Roadmap in turn, open the view, then fast-forward the clock by 30 s and assert no request was sent.
4. On Home, append a `merge_request.opened` event to the run log; assert the MR shows `!77` within 5 s.
5. Assert no request was sent after the first load.

## Expected results

- One `/events` stream, no other request after the first load.
- No request in 30 s of page time on any of the three views.
- `!77` shows on Home within 5 s of the append.
- The test spends no real 30 s.

## Screenshot checkpoints

none: the case asserts requests and text, not appearance.
