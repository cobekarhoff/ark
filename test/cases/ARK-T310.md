---
id: ARK-T310
title: ARK-T310 A dropped event stream shows the frozen-data banner, dims the page, and keeps the stale chip list working without moving the header
level: e2e
technique: state transition (live, stream stopped, stream back) with equivalence classes on the chip (present, absent) while the stream is down
priority: high
risk: "the stream drops and the hub looks live: ages keep ticking, no banner, content not dimmed; or the banner or the open chip list changes the header height (the height across stale counts 0, 1, 4 or more is owned by ARK-T118); or the banner flickers on each EventSource reconnect attempt, stays after the stream returns, or shows no time before the first snapshot; or the chip list is not keyboard reachable or grows the header; or the chip age does not advance with the page clock, so 3 minutes after the last snapshot the chip still reads `0 min` or `1 min`"
status: active
changed_by: 2026-11-15-ARK-493-1
---

## Objective

Prove that when the event stream stops, the hub shows 'Disconnected: data frozen at <time>' and dims the content until the stream returns, that the one stale chip shows the age in minutes and a list of what each source affects, and that neither the banner nor the open list changes the header height. The header height across stale counts is owned by ARK-T118 (AC1 proof: ARK-T310 for the stream, ARK-T118 for the height matrix).

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts`, hub with project `p` and the fake tools, viewport of the other hub specs.
- A proxy in front of the hub, owned by the test: it destroys the open `/events` connection and refuses new ones until restored, so Chromium's real `EventSource` fires `onerror` and reconnects (a route fulfil cannot drop a stream that is already open).
- Fake Orca and Plannotator fail at first (mode `down`); the test writes `up` so each reads once, waits until the chip is gone, then writes `down` again, so 4 or more sources are stale and have an age; the page clock starts at 14:02:05.

## Steps

1. Open Home through the proxy; wait for one chip that reads like 'orca stale 0 min +3'; assert no per-source label, no banner and content not dimmed (opacity 1); read the header height as `h` and the top of `main`.
2. Open the list; advance the page clock 3 minutes; wait until the `orca` row reads 2 or more minutes (whole minutes). The age is the server's `generated_at - read_at` plus the time since the page got its snapshot. A push that arrives after the jump takes the age back to about 0 only because the page clock jumped and the server clock did not. So when a push arrived after the last jump and the row reads `0 min` or `1 min`, advance the clock 3 minutes again and read again; the wait ends only on 2 or more minutes and fails at a 60 s timeout, never at the 15 s default. To make that push certain, append an event to the run's log right after the first jump and wait until the page has seen that push, before the first read: the first read then finds the age near 0, the clock jumps again and the row must end at 2 or more minutes. Assert the rows name what each source affects and the header height is `h`. Press Esc; assert the list closes and focus returns to the chip. Reopen it with the keyboard.
3. Cut the stream. Assert the banner reads 'Disconnected: data frozen at <time of the last snapshot>' and the content is dimmed (opacity 0.55); assert the header height is `h`, the top of `main` is unchanged and the list is still open.
4. Wait for 3 refused reconnect attempts; assert the banner never went missing.
5. Restore the stream; assert the banner and dimming are gone and the header height is `h`.
6. Make the fake tools answer; wait for the chip to vanish; cut the stream again: assert the banner shows with no chip and the height is `h`.

## Expected results

- While the stream is down, the system shall show 'Disconnected: data frozen at <time>' and dim the page content until the stream comes back.
- The stale sources shall show as one chip with the age in minutes, counted from each source's last good read; clicking it shall list what each source affects.
- The header height shall equal `h` with the banner showing and with the list open.
- The chip list shall open and close from the keyboard.

## Screenshot checkpoints

- `stale-chip`: the header with 4 or more stale sources as one chip.
- `chip-list-open`: the chip list open.
- `disconnected-banner`: the banner with dimmed content.
- `reconnected`: the page after the stream returns.
