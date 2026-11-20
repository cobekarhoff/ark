---
id: ARK-T319
title: "ARK-T319 the hub reads the full Orca inbox in the background, keeps the last good value, and marks it truncated or stale"
level: integration
technique: "boundary values (count == limit, count < limit), state transition (good read, failed read, recovery) and equivalence classes of message fields (delivered_at null, thread/payload null or set)"
priority: high
risk: "a failed or limit-capped read shows a partial inbox as complete, an inbox failure drops runs/terminals/waits, bodies leak into the snapshot, or the case takes its first good value from the early `loading` reply (every handle `unmapped`), so the stale value it compares against it holds mapped handles and the case passes or fails with the host's load"
status: active
changed_by: 2026-11-20-ARK-608-1
---

## Objective

Prove that the hub reads `orca orchestration inbox --json --full --limit <large>` in the background, keeps the last good value with its read time, marks it truncated when the count equals the limit and stale when a read fails, and keeps every message field (null `delivered_at` stays null). The idle rule (no read with no page connected, no second loop on reconnect) for this source is owned by ARK-T241.

## Preconditions

- A fake orca (the `test/hub-fixtures.ts` stub, with an `inbox` branch that honors `--limit` and a switchable failure) holding 3 Orca runs and messages with: `delivered_at` null, `thread_id` null and set, `payload` null and an object, and distinct `run_id` per Orca run.
- A hub started on the fixture, with a call log of each `inbox` argument list.
- The fake orca answers every call after a delay longer than the hub's 2 s wait for the handle directory (the opt-in `orca.sleep` state file of the fixture, set to 3 by this case only, before the hub starts), so the hub's first reply is the `loading` reply: `directory` is `loading` and every handle is `unmapped`. The case sets the delay back to 0 after it has seen that reply, so the directory read finishes inside the 15 s wait. No other test sets the delay, and the fixture default stays 0.

## Steps

1. Start the hub on the fixture with the delay set and connect a page to /events. The hub's first reply is the `loading` reply, with no Master Chief agent; set the delay to 0 once the hub is up.
2. Wait until `msg_1` maps to the Master Chief agent in GET /api/conversation (the ready check: it holds on the first reply built after the directory read lands, and not on the `loading` reply). Wait for the first inbox read (read 1, count below the limit N). That reply is the first good value.
3. Read the conversation value (through GET /api/conversation or the module accessor the plan names). Check the arguments logged for the `inbox` call and each stored message. Record the messages and the read time (the first good value).
4. Read the value again right before the failure and record its read time (the last good read time). Make the fake `inbox` fail; wait for the value to be marked `stale`; read it. A read that began before the failure may still publish after it, so the stale value may carry a newer read time than the last good one. Also read /api/snapshot and the runs, terminals and waits it holds.
5. Restore the fake; wait for a read; check the stale flag clears.
6. Read N from the `--limit N` argument in the call log. Make the fake return exactly N messages; wait for the next read; check the truncated flag. Make it return fewer than N; check it clears.
7. Fetch /api/snapshot and a /events frame; search them for a message body string.

## Expected results

- The case reads the first good value only from a reply in which `msg_1` maps to the Master Chief agent, never from the `loading` reply.
- The `inbox` call carries `--json`, `--full` and `--limit <N>` with N larger than the fixture's initial message count.
- Each message keeps id, type, subject, body, thread, Orca run, created time and delivered time; the message with no delivered time has `delivered_at` null, not `created_at`.
- The value carries a read time.
- After the failed read (step 4) the value is marked `stale` and holds the same messages, with the same mapped handles, as the first good value of step 3; its read time is not earlier than the last good read time of step 4 (never compared for equality with the first read, never bounded above by the time of the failure); runs, terminals and waits are still present in the snapshot.
- After the next good read the value is fresh and `stale` is false.
- With exactly N messages returned, the value is `truncated`; with fewer than N it is not.
- No message body appears in /api/snapshot or any /events frame.

## Screenshot checkpoints

none: integration case on hub HTTP and a fake orca CLI; no UI surface.
