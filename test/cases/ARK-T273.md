---
id: ARK-T273
title: ARK-T273 the transcript opens as a list and an inspector: one-line rows of time, kind and summary, a failed call's row red with its error line, and the inspector showing a message, context, thinking, a bash command, an edit input and other arguments through Markdown, Code and Json
level: e2e
technique: equivalence classes of entry kind (user, assistant, context, thinking, bash, edit, write, other tool, failed tool), state transition of selection
priority: high
risk: "a row wraps to many lines or shows the full text; a row has no summary or the wrong one (JSON instead of the bash command or file path); a failed call is not red or has no error line; the inspector shows markdown literally, a bash command as plain text, edit input as markdown or arguments as one unformatted line; a `javascript:` link in injected context becomes live; selecting a row does not change the inspector; the old rows' test ids break the old page tests without being moved"
status: active
changed_by: 2026-11-12-ARK-324-1
---

## Objective

Prove the list and the inspector of `docs/design/rendering/hybrid-2.html` on the transcript of a step. Serves ARK-324/AC3.

Expected: When a step's transcript opens, the system shall show one line for each entry (time, kind, summary), show a failed call's row in red with the first line of its error, and show the selected entry in full in the inspector: message, context and thinking through `Markdown`, a bash command through `Code` as bash, an edit or write input through `Code`, other arguments through `Json`.

## Preconditions

- Hub playwright fixture with a run whose omp step session holds one entry of each kind: user message with markdown (`**bold**`, a list, and a link `[x](javascript:alert(1))`), assistant message, context (`custom_message`) with markdown, thinking, a bash call, an edit call (path and new text), a write call, a `read` call with other arguments (an object), and a failed bash call whose error has several lines.
- One bash call with a 30 KB command (the cut case of ARK-T271) and a long multi-line user message.
- Both themes, as ARK-T96 uses.

## Steps

1. Open the transcript of the step. Take a checkpoint of the list.
2. Read each row: its time, kind and summary text, and its height against a single line.
3. Read the failed call's row: its colour and the text it shows.
4. Select each entry in turn by click. For each, read the inspector: the element kinds inside it (markdown elements, `Code` block with its language, `Json` block).
5. Select the bash call with the 30 KB command and the long user message.
6. Click the markdown link with the `javascript:` target.
7. Repeat the checkpoint in the light theme.

## Expected results

- Every row is one line and has time, kind and summary; the summary of a bash row is its command, of an edit or write row the file path, of a message its first words, of other calls the tool name with its first words.
- The failed call's row is red and shows the first line of its error, not the second.
- User message, assistant message, context and thinking show markdown elements in the inspector (`strong`, list items) and no literal `**`.
- The bash command shows in a `Code` block as bash; edit and write input in a `Code` block; the `read` arguments in a `Json` block, indented.
- The 30 KB command shows its cut with the note in the inspector and its row shows the start of the command, not `{"command":`.
- The `javascript:` link has no live href or does nothing on click; no alert opens.
- Rows and inspector read in light and dark.

## Screenshot checkpoints

`checkpoint(page, "transcript-list-dark")`, `checkpoint(page, "transcript-inspector-markdown")`, `checkpoint(page, "transcript-inspector-bash")`, `checkpoint(page, "transcript-inspector-json")`, `checkpoint(page, "transcript-failed-row")` and `checkpoint(page, "transcript-list-light")`.
