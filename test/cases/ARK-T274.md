---
id: ARK-T274
title: ARK-T274 a tool call in the inspector shows the first line of its result and a Show result control with the size, which loads the full result only on click and shows a JSON result through Json and a text result through Code
level: e2e
technique: equivalence classes of result (JSON, text, no result yet, call without id), state transition (collapsed to loaded), request accounting
priority: high
risk: "the full result is fetched on page load or for every row (a list of 200 rows sends 200 requests); the control is missing or shows no size; a JSON result shows as plain text or a text result is parsed as markdown; a result that looks like JSON but does not parse breaks the page; a call with no result yet or a failed fetch leaves the inspector blank or stuck; a call with no id shows a control that cannot work"
status: active
changed_by: 2026-11-12-ARK-324-1
---

## Objective

Prove Show result in the inspector. Serves ARK-324/AC4.

Expected: When a tool call is selected, the system shall show the first line of its result and a Show result control with the size, and when the control is clicked, the system shall load the result from the result route and show it through `Json` when it parses as JSON, else through `Code`.

## Preconditions

- Hub playwright fixture, omp step session with: a tool call whose result is JSON (an object over several keys, 3 KB), a tool call whose result is multi-line text with a markdown-like line (`# not a heading`), a result of 100 KB (cut), a result that begins with `{` but is not JSON, a tool call with no result record (live step) and a tool call with no string id.
- Request log on the page (as ARK-T27 does).

## Steps

1. Open the transcript of the step. Read the request log: no request to the result route.
2. Select the JSON call. Read the first line of the result and the control with its size. Read the request log.
3. Click Show result. Read the block and the request.
4. Select the text call, click Show result, read the block.
5. Select the 100 KB call, click Show result, read the size, the cut note and the block.
6. Select the call whose result begins with `{` and does not parse, click.
7. Select the call with no result record, click Show result. Select the call with no id.
8. Select another entry and come back to the JSON call.

## Expected results

- After step 1 no request to the result route was sent, and a page of 200 rows sends none per row.
- Before the click an entry shows only the first line of its result and a control labelled Show result with the size (for example `3 KB`).
- The click sends exactly one request to `transcript/result` with the file and the call id; the JSON result shows in a `Json` block, indented; the text result shows in a `Code` block as written, with no heading element.
- The 100 KB result shows the size of the full text, the 64 KB cut and a cut note.
- The non-parsing result shows in `Code`, with no error.
- The call with no result record (404) shows a visible message that the result is not available; the inspector and the list stay usable. The call with no id shows no Show result control.
- Coming back to a loaded result shows it without a second request.

## Screenshot checkpoints

`checkpoint(page, "tool-result-collapsed")`, `checkpoint(page, "tool-result-json")` and `checkpoint(page, "tool-result-text")`.
