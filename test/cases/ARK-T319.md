---
id: ARK-T319
title: "ARK-T319 the hub reads the full Orca inbox in the background, keeps the last good value, and marks it truncated or stale"
level: integration
technique: "boundary values (count == limit, count < limit), state transition (good read, failed read, recovery) and equivalence classes of message fields (delivered_at null, thread/payload null or set)"
priority: high
risk: "a failed or limit-capped read shows a partial inbox as complete, an inbox failure drops runs/terminals/waits, bodies leak into the snapshot"
status: active
changed_by: 2026-11-12-ARK-344-1
---

## Objective

Prove that the hub reads `orca orchestration inbox --json --full --limit <large>` in the background, keeps the last good value with its read time, marks it truncated when the count equals the limit and stale when a read fails, and keeps every message field (null `delivered_at` stays null). The idle rule (no read with no page connected, no second loop on reconnect) for this source is owned by ARK-T241.

## Preconditions

- A fake orca (the `test/hub-fixtures.ts` stub, with an `inbox` branch that honors `--limit` and a switchable failure) holding 3 Orca runs and messages with: `delivered_at` null, `thread_id` null and set, `payload` null and an object, and distinct `run_id` per Orca run.
- A hub started on the fixture, with a call log of each `inbox` argument list.

## Steps

1. Connect a page to /events. Wait for the first inbox read (read 1, count below the limit N).
2. Read the conversation value (through GET /api/conversation or the module accessor the plan names). Check the arguments logged for the `inbox` call and each stored message. Record the messages and the read time (the first good value).
3. Make the fake `inbox` fail; wait for the next read; read the value again. Also read /api/snapshot and the runs, terminals and waits it holds.
4. Restore the fake; wait for a read; check the stale flag clears.
5. Read N from the `--limit N` argument in the call log. Make the fake return exactly N messages; wait for the next read; check the truncated flag. Make it return fewer than N; check it clears.
6. Fetch /api/snapshot and a /events frame; search them for a message body string.

## Expected results

- The `inbox` call carries `--json`, `--full` and `--limit <N>` with N larger than the fixture's initial message count.
- Each message keeps id, type, subject, body, thread, Orca run, created time and delivered time; the message with no delivered time has `delivered_at` null, not `created_at`.
- The value carries a read time.
- After the failed read (step 3) the value is the first good value of step 2: the same messages, marked `stale`, with its read time unchanged; runs, terminals and waits are still present in the snapshot.
- After the next good read the value is fresh and `stale` is false.
- With exactly N messages returned, the value is `truncated`; with fewer than N it is not.
- No message body appears in /api/snapshot or any /events frame.

## Screenshot checkpoints

none: integration case on hub HTTP and a fake orca CLI; no UI surface.
