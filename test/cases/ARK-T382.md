---
id: ARK-T382
title: "ARK-T382 manual ok for a demonstration criterion checks the file as it will be after the answer, refuses a malformed file with the open text and writes nothing"
level: integration
technique: equivalence classes over the demonstration file (malformed in a section, malformed in a value, well-formed with no last line) with state transition of the answer (refused, recorded)
priority: high
risk: "a malformed demonstration file is answered ok and refused later at merge-request open (D12, 11 runs), or the refusal appends gate.answered or human: ok before it checks so the file and the log change with a refusal, or the check demands human: ok before the line is added so the first approval of a good file is refused"
status: active
changed_by: 2026-11-13-ARK-405-1
---

## Objective

Prove `ark gate record <run> manual <AC id> ok` for a `demonstration` AC validates the file with `human: ok` added in memory. A malformed file is refused with the text `ark merge-request open` uses, and the refusal writes no event and changes no file. A well-formed file is accepted on the first answer and ends with exactly one `human: ok`. The repeat answer, the `problem` answer and the files of `inspection` and `analysis` ACs are ARK-T6 (reuse).

## Preconditions

- The `gateRun` fixture of ARK-T6 (`test/evidence-ship.test.ts`: ticket `FAKE-6`, six ACs, a run in the building phase, `results/evidence/<AC id>.md` written by the test), using its `demonstration` ACs `AC1` and `AC4`. It has no worktree event, and the ticket summary is `Ticket FAKE-6` (short title).
- Files the test writes, one at a time: (a) no `What the human saw` section; (b) all sections but no screenshot path under `Before`; (c) well-formed, no last line.
- The test records, before each call: the bytes of the evidence file and the lines of `events.ndjson`.

## Steps

1. Write file (a). Run `ark gate record <run> manual <AC id> ok`. Assert a non-zero exit and an error line `evidence malformed: <AC id>: ...` that names `What the human saw`. Assert the file bytes and the `events.ndjson` lines are unchanged (no `gate.answered`, no `human: ok`).
2. Write file (b). Repeat; the reason names `Before`; nothing changed. Run `ark merge-request check <run> --stage head` and assert it exits 1 and that its output holds the same `evidence malformed: <AC id>: ...` line as the gate refused with (the line is present; the output is not asserted to be only that line, and the files of the other ACs do not exist, which stage `head` does not list).
3. Write file (c). Run the same command. Assert exit 0, one new `gate.answered` event, and that the file's last line is `human: ok` and appears once. The file equals file (c) with trailing whitespace trimmed, a blank line, and `human: ok` plus a newline (the gate writes `<file trimEnd>\n\nhuman: ok\n`).
4. In a fresh run write file (a) for `AC4` and run the command (refused, as in step 1), then replace the file with well-formed file (c) and run the command again: it succeeds (the earlier refusal left no state that blocks it).

## Expected results

- If the file with the line `human: ok` added in memory is malformed, then the system shall refuse the answer with `evidence malformed: <AC id>: <reason>`, the text of the open refusal, and shall write no event and change no file.
- When the file is well-formed except for the missing last line, the system shall record the first approval and write `human: ok` as the last line, once.

## Screenshot checkpoints

none: integration case on CLI output, events and markdown files; no UI surface.
