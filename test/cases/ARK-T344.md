---
id: ARK-T344
title: "ARK-T344 the inspector shows a selected question with sent, delivered, waits, answer, thread and body, and its transcript buttons open the entries nearest the sent time"
level: integration
technique: "equivalence classes (question answered, delivered null, sender without session) with state transition (message to transcript route)"
priority: high
risk: "the inspector shows `sent` where `delivered` is null; the wait or the wait after the answer is wrong; a transcript button opens the start instead of the entry nearest the sent time; a button for an agent with no session is clickable and leads nowhere"
status: active
changed_by: 2026-11-13-ARK-345-1
---

## Objective

Prove the AC4 inspector on a question: its fields, the two transcript buttons landing at the entry nearest the sent time, and the agent summary.

## Preconditions

- A fixture run whose Master Chief asks a question: sent, delivered 12 min later, answered 5 min after delivery; the session files of Chief and the run lead, with entries before and after the sent time; one agent with no session file (a session-kind handle with no mapped file, `ghost`), who sends a message; a second question with `delivered: null`; a worker with steps, messages and cost.
- Viewport 1440x900.

## Steps

1. Open the Conversation tab and click the answered question in the feed.
2. Read the inspector: type, sender, receiver, sent, delivered, wait in minutes (12), the answer and the wait after it (5), the thread, the Markdown body.
3. Click the sender's transcript button: the transcript opens, the entry nearest the sent time is in view and marked. Go back and click the receiver's button.
4. Select the question with `delivered: null`: the inspector shows delivered as not recorded, not the sent time, and no wait.
5. Select the message sent by `ghost` (no session file): its sender button is disabled; the receiver's button still works.
6. Click a worker in the trace: the inspector shows its role, steps with times, messages sent and received, and cost (or none when unknown).

## Expected results

- All message fields show with waits of 12 and 5 minutes and the answer text.
- Each button opens its own transcript at the entry nearest the sent time.
- `delivered: null` is shown as not recorded; a button of an agent without a session is disabled.
- The agent summary shows role, steps, messages and cost when known.

## Screenshot checkpoints

Inspector on the answered question (dark); the transcript after the sender button.
