---
id: ARK-T781
title: ARK-T781 readTerminalSnapshot returns the terminals and runs, and ark companion advise delivers the advice to the live lead, when the fake orca answers terminal list after 3 s and run-list at once and no Orca or reader limit is set
level: integration
technique: boundary values (a terminal list answer at 3 s, past the 2 s reader limit and inside the 10 s Orca limit), at the function and through the command
priority: high
risk: "readTerminalSnapshot cuts orca terminal list at the 2 s reader limit and not at the Orca limit that governs run-list, so on a loaded host (terminal list answers in 2.8 to 17.8 s) the read fails with terminal list failed and ark companion advise reports advice not delivered anywhere to the lead and to Master Chief (ARK-632 three times, ARK-635 once); or the fix reaches the call only when a test sets a limit, so the production default of 10 s is still lost"
status: active
changed_by: 2026-11-21-ARK-642-1
---

## Objective

Prove AC1 of ARK-642 at the function and at the command that the incident named. `readTerminalSnapshot` (`cli/orca.ts`) reads `run-list` with the Orca limit and `terminal list --json` with the same limit, so an answer after 3 s is read when no `ARK_ORCA_TIMEOUT_MS` and no `ARK_READER_TIMEOUT_MS` is set (the production limit is 10 s for the Orca limit). `ark companion advise` reads the same snapshot through `liveChiefOf` and still delivers.

At base the read is cut by the 2 s reader limit: a probe against a fake orca that answers `terminal list` after 3 s and `run-list` at once, with both variables unset, printed `{"ok":false,"reason":"terminal list failed"}` after 2102 ms. The case fails at base for the reason the ticket names.

Expected: When the fake orca answers `terminal list` after 3 s and `ARK_ORCA_TIMEOUT_MS` and `ARK_READER_TIMEOUT_MS` are not set, the system shall return the terminals and the runs, and `ark companion advise` shall deliver the advice to the live lead of the run.

## Preconditions

- The advice project of ARK-T659 (`adviceProject` of `test/companions.test.ts`): companion `cortana`, the open run R1 with the live lead `term_lead1`, the live Master Chief terminal `term_chief` and the fake orca of `test/fake-companion-tools.ts`.
- The existing opt-in settings of that fake: `hangVerbs: ["terminal list"]` and `hangMilliseconds: 3000`. The fake pauses 3 s, appends the call to `hung-done.jsonl`, then answers. `run-list`, `worker-list` and `send` answer at once, so only the `terminal list` read is slow.
- Row 1 deletes `ARK_ORCA_TIMEOUT_MS` and `ARK_READER_TIMEOUT_MS` from `process.env` and restores each saved value in `finally` (`delete` when it was unset), so a value left by the runner or by an earlier test cannot make the case pass.
- Row 2 runs the command through `arkP`. `spawnArk` of `test/helpers.ts` gives the child `ARK_READER_TIMEOUT_MS=30000` and `ARK_ORCA_TIMEOUT_MS=60000` unless `process.env` holds the name, and with those values the 3 s call passes at base too. Row 2 therefore sets `ARK_ORCA_TIMEOUT_MS=""` (read as unset, so 10 s) and `ARK_READER_TIMEOUT_MS="2000"` (the reader default) in `process.env` before the call and restores both in `finally`, as `withProductionLimits` of `test/companions-commands.test.ts` does (it is file-local: reuse it or move it to a shared helper). "No variable set" cannot be literal through the helper.

## Steps

1. Configure the fake with the hang of the preconditions.
2. Row 1: with both variables deleted, call `readTerminalSnapshot()` with no argument. Read the result and `hung-done.jsonl`.
3. Row 2: with the production limits of the preconditions, run `ark companion advise cortana <R1> <advice> --project <project>` through `arkP`. Read the exit code, stdout, stderr, the messages the fake delivered and `hung-done.jsonl`.

## Expected results

- Row 1: the result is `ok: true`. `value.terminals` holds `term_chief`, and `value.runs` holds the Master Chief Run that the fake lists. `hung-done.jsonl` holds the `terminal list` call: the 3 s pause ran to its end and the read waited for it.
- Row 2: exit code 0, stderr empty (no `terminal list failed`, no `Orca did not answer`). The fake delivered the advice to `term_lead1` and one copy to `term_chief` (two sends, as ARK-T746). `hung-done.jsonl` holds the `terminal list` call.
- The case does not assert the subject, type or body of the sends: ARK-T659 owns them. It asserts no elapsed time: a millisecond budget fails under load (ARK-T126), and the marker shows that the call waited for the 3 s answer.

## Screenshot checkpoints

none: a function and CLI case with a fake orca; there is no UI surface.
