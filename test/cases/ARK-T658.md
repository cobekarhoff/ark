---
id: ARK-T658
title: ARK-T658 ark companion ask wakes the companion with the question, and ark companion answer appends the answer to companions/<name>/answers.md and sends Master Chief a copy, also from a process with no Orca session
level: integration
technique: state transition (question sent, answer recorded) and equivalence classes on the caller (an Orca session, no session as in the hub process) and on the name (listed, not listed, unsafe)
priority: high
risk: "the question is sent to Master Chief or to nobody instead of the companion; an answer is lost because only the copy is sent, or only the file is written; a second answer overwrites the first instead of appending; called without ORCA_AGENT_SESSION_ID (from the hub) the message has no sender or no Master Chief to go to; an unknown name or a name with `..` creates a folder outside companions/ or wakes the wrong worker"
status: active
changed_by: 2026-11-14-ARK-480-1
---

## Objective

Prove `ark companion ask <name> <question>` sends the live companion one wake message that holds the question, and `ark companion answer <name> <text>` appends the text to `companions/<name>/answers.md` and sends Master Chief one copy. Serves ARK-480/AC4.

## Preconditions

- A temp `ARK_HOME`, project `p` with the companion `cortana` listed and a live worker recorded by a sync (fake orca of ARK-T656: it also lists the live Master Chief terminal and Run, and logs each `send` with `--to`, `--from`, subject and body).
- The test clock for the time of each answer line.

## Steps

1. Run `ark companion ask cortana "Which runs failed on lint?" --project p` with `ORCA_AGENT_SESSION_ID` set.
2. Run `ark companion answer cortana "Runs 14 and 15 failed on lint." --project p`.
3. Run `ark companion answer cortana "A second answer." --project p`.
4. Repeat steps 1 and 2 with `ORCA_AGENT_SESSION_ID` unset (the hub process).
5. Run `ask` and `answer` for a name that is not in `ark.yml` (`ghost`) and for `../x`.
6. Run `ask` when the companion has no live worker, and `answer` when Orca is down.

## Expected results

- Step 1: exit 0; one `send` goes to the companion's recorded dispatch, and its body holds the question and says it is a question from the human or Master Chief (not a trigger wake); no `send` goes to Master Chief.
- Step 2: exit 0; `companions/cortana/answers.md` ends with the answer text and its time from the test clock; one `send` to Master Chief whose body holds the answer text and the companion's name.
- Step 3: `answers.md` holds both answers in order, the first intact.
- Step 4: the same results; each `send` finds Master Chief and the companion without a session variable, and nothing is sent to a missing recipient.
- Step 5: both exit 1 with one `ark: ` line (the name is not in ark.yml); no `send`; no folder is created under `companions/` or outside it.
- Step 6: `ask` for a companion with no live worker exits 1 with an `ark: ` line that says it is not running, sends nothing; `answer` with Orca down still appends to `answers.md`, exits 1 with an `ark: ` line that says the copy to Master Chief failed, so the answer is never lost silently. [INFERENCE: file first, copy second; the plan may choose the order, and the case asserts only that the failure is named and the file keeps the answer.]

## Screenshot checkpoints

None. The surface is CLI output and files; no screenshot applies.
