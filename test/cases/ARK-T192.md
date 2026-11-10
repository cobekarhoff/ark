---
id: ARK-T192
title: ARK-T192 ark retro lists failed tool calls of omp, claude and codex sessions by tool and first command word, in metrics.json and in the retro output
level: integration
technique: equivalence classes (tool with a command, tool without one, codex shell wrapper), boundary values (error line length, ties in count, more than five pairs)
priority: high
risk: the list names the wrong pair or the wrong owner, because a parser drops the tool name, reads `bash` from codex `["bash","-lc",...]` instead of the script word, counts a failed call of another session set than `tool_errors`, writes a multi-line or unbounded first error into metrics.json, or orders ties wrongly
status: active
changed_by: 2026-11-10-ARK-410-1
---

## Objective

Prove that `ark retro` on a run with one session file of each parser (omp, claude, codex), each with 3 failed tool calls of 2 tools, writes the same pairs, counts and first error lines to `orchestration.tool_error_list` in `metrics.json`, and prints the five largest on stdout. Settles the rules the plan must keep:

- Pair: `{tool, word}`. `word` is the first whitespace-separated word of the command argument. A tool with no command argument (omp `edit` and `read`, claude `Read` and `Edit`, codex calls with no `command`) has `word: ""`. The pair key is `(tool, "")`.
- Codex shell: `command: ["bash","-lc","<script>"]` gives the first word of `<script>`, not `bash`. A command array without the `-lc` wrapper (`["git","status"]`) gives its first element. The tool name stays the codex function name (`shell`).
- Failure rule for codex: the rule of `codexResult` in `hub/transcript.ts` (`metadata.exit_code` not 0, `success: false`, or an "exit code N" line in the output). `function_call_output` and `custom_tool_call_output` pair to their call by `call_id`.
- Sessions covered: every session of the run, the same set that feeds `tool_errors`. The list counts failed calls, `tool_errors` counts messages, so the sums can differ (two failed calls in one message count 1 and 2).
- Order: count descending, then tool ascending, then word ascending (plain string comparison). The list holds all pairs; only the printed output is cut to five.
- First error line: the first non-empty line of the error text of the first failed call of the pair, trimmed, at most 120 characters (longer lines cut to 120).

Expected: When `ark retro` runs on a run with failed tool calls, the system shall write one entry for each pair of tool and first command word, with its count and first error line, to `metrics.json`, and print the five largest entries.

## Preconditions

- A temporary `ARK_HOME` with a fixture run, its `events.ndjson` and agent sessions as in `test/retro.test.ts`.
- Three session files under `test/fixtures/retro/`: `omp/`, `claude/` (exist) and a new `codex/` fixture (rollout `response_item` records, shape as in `test/hub-fixtures.ts:600-627`). Each has exactly 3 failed calls of 2 tools plus at least one successful call of the same tool and word, which must not count:
  - omp / claude: `bash` with `orca ...` fails twice (the first error line has 2 lines in the output); `edit` (claude `Edit`) with no command fails once.
  - codex: `shell` with `["bash","-lc","orca status --json"]` fails twice (`metadata.exit_code` 2, once with `success: false` only); `apply_patch` (a `custom_tool_call`, no command) fails once.
  - One failed error line longer than 120 characters in one fixture.
  - One extra pair with the same count as another pair, to pin the tie order.
- The fixture run puts the omp, claude and codex sessions in the same run, so the covered set is all sessions.

## Steps

1. Run `ark retro <run>` for the fixture run; read stdout and `metrics.json`.
2. Run it with a run of 7 or more distinct pairs and read stdout.
3. Run it with a run whose sessions have no failed calls.

## Expected results

- `orchestration.tool_error_list` sits next to `tool_errors`, with entries `{tool, word, count, first_error}`.
- For each parser the entries are: `(bash|shell, "orca")` count 2, and the no-command tool with `word: ""` count 1. The codex `shell` pair has word `orca`, not `bash`.
- Entry counts sum to 9 for the three sessions (3 each); successful calls add nothing.
- `first_error` has one line, no newline, at most 120 characters.
- Entries are ordered count desc, tool asc, word asc, and the tie in the fixture appears in that order.
- With 7 or more pairs `metrics.json` holds all of them and stdout prints exactly five `tool error: <tool>[ <word>] x<count>: <first error line>` lines after the `orchestration:` line, largest first; the word is omitted when empty.
- With no failed calls the list is `[]` and no `tool error:` line prints.
- A failed call with a tool name but an unreadable command gives `word: ""` and does not throw.

## Screenshot checkpoints

None, CLI and file output.
