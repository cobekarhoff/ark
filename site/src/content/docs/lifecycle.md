---
title: Lifecycle and human gates
description: The legal state transitions, human decisions, bounded rounds and final outcomes of a run.
---

A **run** is one attempt to take a ticket to an outcome. It has a ledger, a cached
state and artifacts under `~/.ark/projects/<project>/runs/<date>-<ticket>-<number>/`
(or the corresponding `ARK_HOME` root). One ticket can have many runs over time,
but at most one is open. The command-line interface (CLI) enforces the lifecycle;
the orchestrator chooses the next legal action, not an arbitrary new state.

## The normal path

Intake reads each acceptance criterion (AC). Analysis records what the code needs;
the plan proposes the change and the proof for each AC.
Human plan approval precedes `build.started`. Implementation happens in a worktree,
then a validator proves behavior and a reviewer examines the change. `build.completed`
moves `building` to `judging` even if checks failed: judgment and rounds decide what returns.
The [interactive explorer](/flow/#run-lifecycle) shows **every event and destination**
from `cli/transitions.ts`, including self-loops, aborts and terminal states.

## Decisions belong to humans

| Gate | When it appears | Fixed answers | What the decision means |
| --- | --- | --- | --- |
| `criteria` | Only when the ticket has no ACs | `accept`, `edit`, `abort` | Accept clarity, revise criteria, or stop before analysis proceeds |
| `plan` | After analysis and plan | `approve`, `change`, `abort` | Approve approach and AC kinds; change returns to analysis |
| `escalation` | Failures remain after the round budget | `one_more_round`, `take_over`, `abort` | Authorize one more round, implement as a human, or stop |
| `evidence` | After a passing trace check | `approve`, `send_back`, `abort` | Approve the evidence, return to work, or stop |

`setup` is **reserved, not implemented**. Host merge is a separate human action,
not another implemented gate ID.

`ark gate packet` freezes the packet by its 256-bit Secure Hash Algorithm (SHA-256)
hash. The orchestrator shows it, asks the matching fixed-choice question and
submits the human answer. Approvals rebuild the packet and refuse stale sources.
An edit at criteria stays there: the human edits the ticket, the orchestrator runs
`ark acceptance-criteria update`, then builds and answers a new packet. Plan
approval refuses until every AC is marked `new` or `preserved`.

## Loops are bounded, not acyclic

`loop.max_rounds` in `ark.yml` sets the budget, default **two**. `state.json`'s
`round` counts returns to implementation, not individual agent calls. A
`fix_round.started`, an evidence send-back within budget, and a positive escalation
answer each count a round. Check the shared premise in `premise.md` before the last round.

When the budget is spent, `fix_round.started` refuses. Remaining failures require
an escalation packet. An evidence send-back past the budget counts no new round
and moves to `escalating`, where only opening escalation or aborting is legal.
`one_more_round` and `take_over` return to `building`; human takeover still needs
committed, attributed changes and human confirmation of the implementation step.

## Opening is not merging

Evidence approval normally moves to `merge_requests_open`. Ark pushes the approved
branches and opens one merge request (MR) per repository. The human merges or
closes them on the host and confirms `merged` or `abandoned` with `ark run close`.
`merged` requires an MR for every repository; `abandoned` requires at least one.
After any MR opens, abort and handoff are no longer available.

Before any MR exists, stopping records `aborted`. With `merge_requests: false`,
evidence approval instead closes as `handed_off`, leaving ready branches with the
human. The pure state table is not the entire guard contract: CLI handlers enforce
these outcome, budget, attribution and evidence checks too.

Source: `cli/transitions.ts`, `skills/ark/playbooks/ticket.md`, `cli/run.ts` and the
[implementation reference](/reference/implementation/).
