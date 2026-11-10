---
id: ARK-T175
title: ARK-T175 Json shows a 40-line value indented by 2 with token colours, folds to 12 lines behind Show all; Code shows its language label and a Copy button that copies the source
level: e2e
technique: boundary values (12 and 40 lines), state transition (folded, expanded)
priority: high
risk: "JSON is not indented by 2 or loses a token colour, a block over 12 lines does not fold or Show all does not expand it, Code has no language label, Copy puts different text on the clipboard"
status: active
changed_by: 2026-11-09-ARK-323-1
---

## Objective

Prove `Json` and `Code`. Expected: When a JSON value is longer than 12 lines, `Json` shall fold it to 12 lines with a Show all control; `Code` shall show the language label and a Copy button.

## Preconditions

- Hub playwright fixture: a `.json` run file whose value prints as 40 lines at indent 2, holding a key, string, number, true, false and null; a `.md` run file with a fenced ```ts block.
- Playwright grants clipboard read and write permission.

## Steps

1. Open the `.json` run file. Assert the Json block shows 12 lines and a Show all control, and that the source indent is 2 spaces.
2. Assert distinct computed colours for a key, a string, a number, a boolean and null.
3. Click Show all. Assert all 40 lines show.
4. Open the `.md` file. Assert the fenced block shows the label `ts` and a Copy button.
5. Click Copy. Assert the clipboard text equals the block source exactly.

## Expected results

- 12 lines folded, 40 after Show all; indent 2; five token colours differ.
- Code shows its label and Copy puts the exact source on the clipboard.

## Screenshot checkpoints

`checkpoint(page, "json-folded")`, `checkpoint(page, "json-expanded")`, `checkpoint(page, "code-label-copy")` before their assertions.
