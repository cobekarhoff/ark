---
id: ARK-T181
title: ARK-T181 the run file viewer and the ticket page each have a Rendered and Raw switch and Raw shows the source text as written
level: e2e
technique: state transition (rendered, raw, rendered), equivalence classes of file types
priority: medium
risk: "Raw shows the rendered or reformatted text (a .json file pretty-printed instead of as written), the switch is missing on one view or resets on a file change, or Rendered does not come back"
status: active
changed_by: 2026-11-09-ARK-323-1
---

## Objective

Prove the switch. Expected: When Raw is chosen, the system shall show the source text as written.

## Preconditions

- Hub playwright fixture of ARK-T179: ticket with markdown in Problem, Change, Evidence and AC text; run files `plan.md` and a `state.json` stored on one line (unformatted).

## Steps

1. Open the run file `plan.md`. Click Raw. Assert the exact source (`**bold**`, `##`, backticks) shows and no `strong` element. Click Rendered. Assert the elements return.
2. Open `state.json`. Click Raw. Assert the text equals the file bytes (one line, unformatted).
3. Open the ticket page. Click Raw. Assert Problem, Change, Evidence and each AC text show their source as written. Click Rendered. Assert elements return.

## Expected results

- Raw shows the source exactly on both views; Rendered restores the elements.

## Screenshot checkpoints

`checkpoint(page, "run-file-raw")` and `checkpoint(page, "ticket-raw")` before their assertions.
