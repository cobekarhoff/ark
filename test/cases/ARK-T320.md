---
id: ARK-T320
title: "ARK-T320 every message handle maps to Master Chief, a run lead, a worker with step and role, a session agent, or an unmapped agent"
level: integration
technique: "state transition (`loading` reply, then the reply with the directory), equivalence classes of handle kind (run:, dispatch:, terminal, structworker_) and sender/receiver, plus an error-guessing class for an unknown handle"
priority: high
risk: "a handle of one kind lands on the wrong agent (a run lead shown as a worker, a brainstorm session shown as a run lead), or an unknown handle is dropped so its messages vanish from the conversation, or the case reads the early `loading` reply (every handle `unmapped`) as the final mapping, so it passes or fails with the host's load"
status: active
changed_by: 2026-11-20-ARK-574-1
---

## Objective

Prove that each handle form maps to exactly one agent of the right kind, that a worker carries its step and role from the task title, and that an unknown handle stays as an `unmapped` agent with the raw handle.

## Preconditions

- A fake orca with: Master Chief's Orca Run (objective `Master Chief: <project> tickets`); an Ark run's Orca Run (objective `Ark run <run>`); that run's `worker-list` (a run lead, and workers with `dispatchId`, `terminal`, `agentTerminalHandle`); and its `task-list` with these titles, one for each worker: `impl-api (implementer, <repo>)` (step `impl-api`, role implementer, group Implementers); `spec-cases-write (validator, <repo>)` (step `spec-cases-write`, role validator, group Validators); `review-1 (reviewer, <repo>)` (step `review-1`, role reviewer, group Reviewers); `evaluator (<run>)` (step `evaluator`, group Planning); `test-case-writer (<run>)` (step `test-case-writer`, group Planning).
- The fake orca answers every call after a delay longer than the hub's 2 s wait for the handle directory (`orcaSleepSeconds`, or the `orca.sleep` state file), so the hub's first reply is the `loading` reply: `directory` is `loading` and every handle is `unmapped`. The case sets the delay back to 0 after it has seen that reply, so the directory read finishes inside the 15 s wait.
- Messages whose `from_handle`/`to_handle` are: `run:<Master Chief run id>`; `run:<Ark run Orca Run id>`; the run lead's `dispatch:ctx_*` and terminal handle; a `dispatch:ctx_*` and terminal handle of each of the five workers above; a terminal in no worker-list that sent to Master Chief's Run; and a handle `term_unknown` in no list that sent to nobody known.

## Steps

1. Start the hub on the fixture with a page connected and the delay set; fetch GET /api/conversation once and check that it is the `loading` reply with no Master Chief agent; set the delay to 0.
2. Wait until `msg_1` maps to the Master Chief agent in GET /api/conversation (the ready check: it holds on the first reply built after the directory read lands, and not on the `loading` reply). Then fetch GET /api/run/<run>/conversation and GET /api/conversation.
3. For each handle in the preconditions, find the agent it maps to in the answers.
4. Count the agents and the messages for the unmapped handle.

## Expected results

- The first reply, built before the directory read lands, is `loading` and has no Master Chief agent; the case reads every mapping below only from a reply in which `msg_1` maps to the Master Chief agent.
- `run:<Master Chief run id>` maps to the Master Chief agent.
- `run:<Ark run Orca Run id>`, the run lead's dispatch handle and its terminal handle map to one run lead agent of that run.
- A worker's dispatch handle and its terminal handle map to one worker agent, with its step and role from the task title; the `impl-api`, `spec-cases-write` and `review-1` titles give role implementer, validator and reviewer in groups Implementers, Validators and Reviewers, and the `evaluator` and `test-case-writer` titles give role group Planning.
- The terminal that sent to Master Chief's Run and is neither run lead nor worker maps to a session agent.
- `term_unknown` maps to an agent of kind `unmapped` whose handle is the raw string; its messages are in the answer.
- No message is missing from the answer for any handle kind; the message counts equal the fixture's.
- A message with a missing field (no `payload`, no `thread_id`) still maps and is kept.

## Screenshot checkpoints

none: integration case on hub HTTP and a fake orca CLI; no UI surface.
