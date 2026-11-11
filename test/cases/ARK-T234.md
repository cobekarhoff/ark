---
id: ARK-T234
title: ARK-T234 A text amend of a manual criterion with `--carry-manual` keeps the answer and records the old text, new text, reason and the human's words
level: integration
technique: state transition (manual answer, text amend with carry words), then a second text amend to check the old text chain
priority: high
risk: the carry flag only reaches the CLI and not the event, so the reducer still clears the answer on replay, or the words are lost and the decision has no audit trail
status: active
changed_by: 2026-11-10-ARK-361-1
---

## Objective

Prove that the human's explicit decision keeps the answer and is recorded in the event. Serves ARK-361/AC4.

Expected: Where `--carry-manual <words>` is given with a text amend, the system shall keep the manual answer and record the old text, the new text, the reason and the words in criteria.amended.

## Preconditions

- A temporary `ARK_HOME`, project and git repo; a run in building with AC1 `manual: true` answered `ok`.
- A text file for AC1 with new text.

## Steps

1. Run `ark criteria amend <run> AC1 <file> --reason "wording" --carry-manual "human: same decision, wording only"`.
2. Read the event, ticket.md and the manual gate state.
3. Rebuild the state from events (run `ark status <run>` in a fresh process).

## Expected results

- The event holds old text, new text, reason, and `carry_manual` equal to the words.
- ticket.md has the new text; AC1's answer is still `ok` after the state rebuild.
- Amended criteria lists the old to new text pair.

## Screenshot checkpoints

none: CLI and state assertions only
