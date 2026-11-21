---
id: ARK-T782
title: ARK-T782 with ARK_ORCA_TIMEOUT_MS=1000, readTerminalSnapshot fails with a reason that names terminal list before the fake orca answers its 3 s terminal list, so the one Orca limit governs both reads
level: integration
technique: boundary values (Orca limit 1 s, terminal list answer at 3 s) with the reader limit held at 30 s so only the Orca limit can cut the call
priority: high
risk: "terminal list keeps its own limit and ignores ARK_ORCA_TIMEOUT_MS (the reader limit, 2 s by default), so a test or an operator that shortens or raises the Orca limit moves run-list and leaves terminal list where it was: with the reader limit at 30 s the 1 s Orca limit does not cut the 3 s call and the read returns ok after 3 s; or the fix drops the reason and the failure no longer names terminal list"
status: active
changed_by: 2026-11-21-ARK-642-1
---

## Objective

Prove AC2 of ARK-642: `ARK_ORCA_TIMEOUT_MS` governs `terminal list` as it governs `run-list`. With the limit at 1000 ms and the fake orca answering `terminal list` after 3 s, `readTerminalSnapshot()` returns `ok: false` with the reason `terminal list failed`, and does not wait for the answer.

The reader limit is pinned to 30 s on purpose. A probe at base with the Orca limit at 1000 and the reader limit unset printed `{"ok":false,"reason":"terminal list failed"}` after 2105 ms, so the 2 s reader limit alone makes "fails within 2 s" nearly true at base. With the reader limit at 30000 and the Orca limit at 1000, the probe at base printed `ok: true` with the terminals after 3014 ms. The case fails at base for the reason the ticket names and does not depend on host load.

Expected: When `ARK_ORCA_TIMEOUT_MS` is 1000 and the fake orca answers `terminal list` after 3 s, the system shall fail the read with the reason `terminal list failed` before it gets that answer.

## Preconditions

- The fake orca and tools of `test/fake-companion-tools.ts` with the instant `run-list` of ARK-T781 and the opt-in settings `hangVerbs: ["terminal list"]` and `hangMilliseconds: 3000`.
- The test sets `process.env.ARK_ORCA_TIMEOUT_MS = "1000"` and `process.env.ARK_READER_TIMEOUT_MS = "30000"` before the call, and restores each saved value in `finally` (`delete` when it was unset).
- The call runs in the test process: `readTerminalSnapshot` is an export with production callers, so no test-only seam is added. The command boundary of the same limit is the control row of ARK-T687 (`ark chief handover`).

## Steps

1. Configure the fake with the hang of the preconditions and set the two variables.
2. Call `readTerminalSnapshot()` with no argument. Read the result and `hung-done.jsonl`.

## Expected results

- The result is `ok: false` and `reason` is `terminal list failed` (it names `terminal list`; it does not name the timeout, because the ticket changes nothing else).
- `hung-done.jsonl` is absent: the fake was cut before its 3 s pause ended, so the call did not wait for the answer. The case asserts no upper time bound: a millisecond budget fails under load (ARK-T126), and with the reader limit at 30 s the marker is what separates the fix from base (at base the read waits for the answer and the marker exists).
- A `run-list` failure keeps its own reason (the read returns it first when both reads fail). The ticket changes nothing there, and the case does not assert it.

## Screenshot checkpoints

none: a function case with a fake orca; there is no UI surface.
