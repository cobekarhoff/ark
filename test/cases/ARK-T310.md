---
id: ARK-T310
title: ARK-T310 A dropped event stream shows the frozen-data banner, dims the page, and keeps the stale chip list working without moving the header
level: e2e
technique: state transition (live, stream stopped, stream back) with equivalence classes on the chip (present, absent) while the stream is down
priority: high
risk: "the stream drops and the hub looks live: ages keep ticking, no banner, content not dimmed; or the banner or the open chip list changes the header height (the height across stale counts 0, 1, 4 or more is owned by ARK-T118); or the banner flickers on each EventSource reconnect attempt, stays after the stream returns, or shows no time before the first snapshot; or the chip list is not keyboard reachable or grows the header"
status: active
changed_by: 2026-11-12-ARK-335-1
---

## Objective

Prove that when the event stream stops, the hub shows 'Disconnected: data frozen at <time>' and dims the content until the stream returns, that the one stale chip shows the age in minutes and a list of what each source affects, and that neither the banner nor the open list changes the header height. The header height across stale counts is owned by ARK-T118 (AC1 proof: ARK-T310 for the stream, ARK-T118 for the height matrix).

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts`, hub with project `p` and the fake tools, viewport of the other hub specs.
- A way to stop and restore the `/events` stream mid-page (route fulfil then close, or hub restart), checked to fire `EventSource.onerror` in Chromium.
- A hold gate as in ARK-T117 keeps 4 or more sources stale until released.

## Steps

1. Open Home with the stream up and the tools held (4 or more stale); assert no banner and content not dimmed; read the header height as `h`; assert one chip reads like 'orca stale 28 min' (fixture clock) and no per-source labels show.
2. Click the chip; assert a list names each stale source with what it affects; assert the header height is `h`. Press Esc; assert the list closes and focus returns to the chip. Reopen it with the keyboard.
3. Stop the stream. Assert the banner reads 'Disconnected: data frozen at <time of the last snapshot>' and the content is dimmed; assert the banner does not flicker across 3 reconnect attempts; assert the header height is `h` with the banner showing and with the list open.
4. Advance the clock one minute; assert the chip age moves by whole minutes only, not each second.
5. Restore the stream; assert the banner and dimming are gone and ages move again.
6. Release the tools, wait for the chip to vanish, stop the stream again: assert the banner shows with no chip.

## Expected results

- While the stream is down, the system shall show 'Disconnected: data frozen at <time>' and dim the page content until the stream comes back.
- The stale sources shall show as one chip with the age in minutes; clicking it shall list what each source affects.
- The header height shall equal `h` with the banner showing and with the list open.
- The chip list shall open and close from the keyboard.

## Screenshot checkpoints

- `stale-chip`: the header with 4 or more stale sources as one chip.
- `chip-list-open`: the chip list open.
- `disconnected-banner`: the banner with dimmed content.
- `reconnected`: the page after the stream returns.
