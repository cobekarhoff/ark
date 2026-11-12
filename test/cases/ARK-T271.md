---
id: ARK-T271
title: ARK-T271 a transcript page of an omp, a Claude and a Codex file sends a tool call's arguments up to 20 KB and message, context and thinking text up to 32 KB, cuts longer text with a count of the cut characters, keeps valid arguments and keeps the result as its first line
level: integration
technique: boundary values (limit, limit + 1, 30 KB and 40 KB fixtures), equivalence classes of harness (omp, Claude, Codex)
priority: high
risk: "a harness keeps the old 300 or 8000 limit; the cut note counts wrong or is missing; a cut argument string is no longer valid JSON, so the row summary (bash command, file path) and the inspector lose their field; a tool call has no call id on the page, so Show result cannot ask for it; the first line of the result grows to the full result; the cut counts bytes in one harness and characters in another"
status: active
changed_by: 2026-11-12-ARK-324-1
---

## Objective

Prove that `GET /api/run/<run>/transcript` for each harness carries the new limits. Serves ARK-324/AC1. A limit is a count of characters (UTF-16 units, as `cut()` counts today), not of bytes.

Expected: When a transcript page is read, the system shall send each tool call's arguments in full up to 20 KB and each message, context and thinking text in full up to 32 KB, cut longer text with a note of how many characters were cut, and keep the result of a call as its first line.

## Preconditions

- Hub test server with a fixture run whose session files are built by the `transcriptText` and `transcriptTexts` helpers of `test/hub-fixtures.ts`, extended with options for a long argument and a long message (no second builder). One file each for omp, Claude and Codex, each with:
  - a tool call with a 30 KB argument: for omp and Claude a `bash` call whose `command` is 30 KB; for Codex a `shell` call with a 30 KB script;
  - a tool call with a 20 KB argument exactly, and one with 20 KB + 1 character;
  - a user message of 40 KB, an assistant message of 32 KB exactly and one of 32 KB + 1 character, a thinking block of 40 KB;
  - for omp one `custom_message` (context) of 40 KB;
  - a tool call with a short result whose second line holds the `tail` text, and a tool call with no string id.
- Texts hold a multi-byte character (a 3-byte one), so a byte count and a character count differ.

## Steps

1. For each harness, read the first page from the route.
2. For each long entry, read its text or arguments and the cut note.
3. For the 30 KB argument, `JSON.parse` the arguments field of the entry (each long string field is cut, with the cut note inside the field), and read the separate row summary field the page carries for it (the bash command, the file path), parsed from the call before the cut.
4. Read the result field of each tool entry and the call id field.
5. Run `bun test test/hub.test.ts`.

## Expected results

- The 30 KB argument arrives as 20 KB of characters plus a note `(+10000 characters cut)` of the real count; the 40 KB message and the 40 KB thinking and context text arrive as 32 KB plus `(+8000 characters cut)`; the same in all three harnesses.
- The argument of exactly 20 KB and the text of exactly 32 KB arrive whole with no note; one more character cuts one character and the note says `+1`.
- The arguments field of a cut call is valid JSON: `JSON.parse` succeeds, each long string field is cut with its note inside the field, and the whole HTTP response is valid JSON. The entry also carries the row summary (bash command, file path) as a separate field, readable and parsed from the whole call; both hold together.
- The result field of every tool entry is its first line; the `tail` text is nowhere in the page.
- A tool entry carries its call id in each harness; the entry with no string id carries none.
- The multi-byte text is cut at the character count: the note and the length agree.
- The old tests at `test/hub.test.ts` (page of 200, bad cursor, foreign file) still pass, those that pin the old limits changed and carrying a case id.

## Screenshot checkpoints

None, route output.
