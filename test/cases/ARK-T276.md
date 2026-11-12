---
id: ARK-T276
title: ARK-T276 a context entry of 114 lines and a user message of more than 40 lines are one list row and show in full in the inspector, thinking is folded until a click, and the run files are pinned below the list and open in the same inspector
level: e2e
technique: boundary values (40 and 41 lines, 114 lines), equivalence classes of entry (omp context, Claude user message, Codex user message, thinking) and run file (md, json, txt, missing)
priority: high
risk: "a long context entry fills the list or hides the turn below it (the failure that opened the ticket); the inspector shows only the first lines of a long entry; thinking shows open by default; the run files are missing from the transcript page, open as a separate page instead of in the inspector, or lose their renderer; the full-page run file route no longer works; a missing run file has a pinned link"
status: active
changed_by: 2026-11-12-ARK-324-1
---

## Objective

Prove the fold of long text, folded thinking and the pinned run files. Serves ARK-324/AC6. What the case observes for the fold: the entry is one row and the inspector holds all of its lines; the row summary is the first words. The kind `context` exists only in omp (`custom_message`); Claude and Codex show injected text as a `user` message, so the user-message part runs on those two.

Expected: When a context entry or a user message of more than 40 lines is on the page, the system shall show it as one list row and in full in the inspector when selected; thinking shall be folded in the inspector until a click; the run files of the run shall be pinned below the list and open in the same inspector through the renderer of ARK-323.

## Preconditions

- Hub playwright fixture, run with: an omp session with a `custom_message` of 114 lines (markdown with a heading, a list and a code fence) followed by a user message, a thinking block, an assistant message and a bash call; a Claude session and a Codex session each with a user message of 114 lines, one with 41 lines and one with 40 lines.
- The run folder holds `plan.md`, `state.json`, `notes.txt`; a run file that is listed in the run but missing on disk is not required to exist.

## Steps

1. Open the omp transcript. Count the list rows and read the context row's text and height. Read where the next entries (user message, assistant message) sit relative to the top of the list.
2. Select the context row. Count the lines of text in the inspector and read its last line.
3. Select the thinking entry. Read whether its text shows. Click the fold. Read again.
4. Open the Claude and Codex transcripts; repeat step 2 for the 114-, 41- and 40-line user messages.
5. Read the area below the list: the pinned run files.
6. Click `plan.md`, then `state.json`, then `notes.txt`. Read the inspector and the URL each time.
7. Click an entry again; then open the full page route `#/run/<run>/file/plan.md`.

## Expected results

- The 114-line context is one row of one line (summary: its first words), with the next entries visible without scrolling past it.
- The inspector shows all 114 lines, first to last, and rendered markdown (heading, list, code fence).
- The 41-line and 40-line user messages are each one row, and the inspector holds every line of both; Claude and Codex give the same.
- The thinking text is hidden until the click and shows after it.
- The run files `plan.md`, `state.json` and `notes.txt` are listed below the list, and no entry for a file that does not exist.
- A click on a file opens it in the same inspector: `plan.md` through `Markdown`, `state.json` through `Json`, `notes.txt` through `Code` as plain text; the list and the page stay where they were.
- Selecting an entry after a file shows the entry again.
- The full-page file route still opens `plan.md` rendered (ARK-T182 and ARK-T179 still pass).

## Screenshot checkpoints

`checkpoint(page, "context-row-dark")`, `checkpoint(page, "context-inspector-full")`, `checkpoint(page, "thinking-folded")` and `checkpoint(page, "run-file-in-inspector")`.
