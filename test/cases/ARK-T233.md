---
id: ARK-T233
title: ARK-T233 A text amend of a manual criterion that adds a requirement clears its manual answer
level: integration
technique: state transition (manual answer recorded, then text amend with no carry words); regression of today's rule
priority: high
risk: the new `--carry-manual` change keeps answers by default, so an added requirement is accepted by an old `ok` that never saw it
status: active
changed_by: 2026-11-10-ARK-361-1
---

## Objective

Prove that the existing clearing rule stays when no human words are given. Serves ARK-361/AC4.

Expected: When the text of a manual criterion is amended with no `--carry-manual`, the system shall clear its manual answer.

## Preconditions

- A temporary `ARK_HOME`, project and git repo; a run in building with AC1 `manual: true` answered `ok`; AC3 manual, answered `ok`.
- A text file for AC1 that adds a requirement to the text.

## Steps

1. Run `ark criteria amend <run> AC1 <file> --reason "adds a requirement"`.
2. Read the gate state of AC1 and AC3 and the event.
3. Run the same with `--carry-manual ""` and `--carry-manual "  "`.
4. Run `--carry-manual "words"` with `--verified-by` and without a file.

## Expected results

- AC1's manual answer is cleared; AC3's answer is kept.
- The event has the old text, new text and reason and no carry field.
- Empty or blank carry words are refused and change nothing.
- `--carry-manual` with the `--verified-by` form is refused; so is `--carry-manual` on a non-manual criterion.

## Screenshot checkpoints

none: CLI and state assertions only
