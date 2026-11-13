---
id: ARK-T321
title: "ARK-T321 the conversation routes answer agents, role groups, spans, events, messages, human answers and question times from the worker thread"
level: integration
technique: "state transition (question sent, delivered, relayed, answered), boundary values (delivered_at null, open span, repeated step rounds, time window edges) and equivalence classes of route"
priority: high
risk: "a run's conversation misses its spans, answer time or relay, a bad time window or unknown id gives a wrong status, bodies leak into the project answer, or the build runs on the main thread and blocks the hub"
status: active
changed_by: 2026-11-12-ARK-344-1
---

## Objective

Prove that GET /api/run/<run>/conversation, GET /api/conversation and GET /api/conversation/message/<id> answer the data the AC lists, built by the usage worker thread, with sent, delivered and answered times for a question that is relayed and answered by the human.

## Preconditions

- The worker fixture of ARK-T320: workers with explicit implementer, validator, reviewer and planning task titles, so each role group (Planning, Implementers, Validators, Reviewers) holds a worker.
- A fixture run with `events.ndjson` holding `step.started`/`step.finished` for two workers (one step started twice in two rounds, one step with no `step.finished`), and a `gate.answered` with `by: human` and one with `by: auto`.
- A fake orca inbox with: a run lead question to Master Chief (created T0; delivered T1 > T0 in one case and `delivered_at` null in another), a relay (Master Chief to the run lead, same thread), a message from a worker, and a message of another run.
- The hub started on the fixture with a page connected so the inbox is read.

## Steps

1. GET /api/run/<run>/conversation.
2. GET /api/conversation with the time window that holds the fixture (the `since`/`until` names the plan fixes), then with a window that excludes it, then with a bad window value.
3. GET /api/conversation/message/<id> for a known id and for an unknown id and for an id with `/` or `..` in it.
4. Check that the usage worker thread built the answers (the worker request count, or the build running off the main thread by the plan's accessor), and that /nope still answers while a build runs.

## Expected results

- The run answer lists Master Chief, the run lead and each worker, each worker with its role group: the planning workers in Planning, the implementer in Implementers, the validator in Validators, the reviewer in Reviewers (all four groups are asserted).
- Each worker's spans come from `step.started` and `step.finished`: a repeated step gives two spans, and a step with no `step.finished` gives an open span.
- The run answer holds the run's Ark events, the messages to and from its agents (not the other run's), and the `gate.answered` by human (not the `auto` one).
- For the question: `sent` is the message's created time, `delivered` is its delivered time or null (never `created_at`), `answered` is the time of the nearest human answer after delivery in the same run (the join rule the plan states), or null when none.
- The project answer holds every run in the window, with agents, spans, events, times and no message `body` field; the empty window gives no runs; a bad window gives 400.
- The message route gives one body as JSON; an unknown id gives 404; a hostile id gives 404 and reads no path.
- The build runs in the usage worker thread, and `/nope` still answers during a build.

## Screenshot checkpoints

none: integration case on hub HTTP routes and JSON; no UI surface.
