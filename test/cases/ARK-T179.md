---
id: ARK-T179
title: ARK-T179 each surface renders through Markdown, a .json run file through Json and any other run file through Code as plain text
level: e2e
technique: equivalence classes of surfaces
priority: high
risk: "a surface keeps showing literal markdown (an old Prose or pre path survives), a .json file is not formatted, or another file type is rendered as markdown"
status: active
changed_by: 2026-11-12-ARK-324-1
---

## Objective

Prove every AC5 surface renders markdown. Expected: The system shall render the ticket Problem, Change, Evidence and AC text, each `.md` run file, each gate question, the decisions timeline text and the Roadmap notes through `Markdown`; a `.json` run file through `Json`; any other run file through `Code` as plain text.

## Preconditions

- Hub playwright fixture: a ticket with `**bold**`, a list and `code` in Problem, Change, Evidence and one AC; a run with `plan.md`, `state.json`, `notes.txt`; a gate question with `**bold**` and a list; a decision event whose text holds markdown; a Roadmap note with markdown.
- Transcript messages and context render through `Markdown` in the inspector, covered by ARK-T273.

## Steps

1. Open the ticket page. Assert `strong`, list items and inline `code` exist in Problem, Change, Evidence and the AC text, and no literal `**` shows.
2. Open the run file `plan.md`. Assert rendered markdown elements.
3. Open `state.json`. Assert a Json block, indented and folded as in ARK-T175.
4. Open `notes.txt`. Assert a Code block shows the text as written with no markdown element.
5. Open Home. Assert the gate question shows `strong` and list items.
6. Open the run page. Assert the decision text shows rendered markdown.
7. Open Roadmap. Assert the note shows rendered markdown.

## Expected results

- Every listed surface shows markdown elements and no literal markers; `.json` shows Json; other files show Code as plain text.

## Screenshot checkpoints

`checkpoint(page, "<surface>")` for each of the seven surfaces before its assertions.
