---
id: ARK-T377
title: "ARK-T377 ark retro places a session by the worker spec line of this run: a validator before its window goes to its step, a test case session inside a window does not, a placeholder run id places nothing"
level: integration
technique: "decision table on (spec line present with this run id) x (word: test case role, step id, other) x (start inside, before or outside a step window); boundary on the run id (placeholder, other run, real run)"
priority: high
risk: "a validator session that starts before step.started stays unassigned, so its step cost and the validator role cost are too low; a writer session that starts inside an implementer window is counted as the implementer step, so the step cost and its models are wrong; a placeholder line from the ark skill description or a playbook (the run id is <run>) places a session wrongly, for example a run lead as a step or a stray session as a writer; a spec line of another run places a session of this run, also when its run id extends this run id; a Codex worker session is left unplaced because the reader takes the first user record, which Codex fills with injected context, instead of every record before the first assistant record"
status: active
changed_by: 2026-11-13-ARK-460-1
---

## Objective

Prove that `ark retro` reads the worker spec line of this run from the head of a session file, and places a session by it when the window rule alone gives no owner or the wrong one. Serves ARK-460/AC2.

Expected: When the prompt records of a session (every record before its first assistant record) hold the worker spec line of this run with a step id, the system shall add the cost to that step and role even when the session starts before `step.started`; when the word is `test-case-writer` or `test-case-reviewer`, the system shall give the session to `test_writer` or `test_reviewer` even inside a step window; when the run id is a placeholder, the system shall place nothing.

## Preconditions

- A temporary `ARK_HOME` with a closed run: an implementer step `build` and a validator step `check`, each with `step.started` and `step.finished`, and no `worker.started` event for `check`. The run lead file starts before the first step.
- Prompt records: every record of the session before its first assistant record, inside the first 64 KiB. The spec line is read there, nowhere else.
  - omp: the spec line is not a user record. It is the `custom_message` record with `customType: "skill-prompt"`: `content` holds `=== TASK === worker <run id> <word>` followed by the task text, and `details` holds `args` with the same line and `prompt` with `/skill:ark worker <run id> <word>` on its own line. The fixtures copy the record from a real head, `~/.omp/agent/sessions/-.ark-projects-ark-runs-2026-11-13-ARK-460-1-workspace/2026-11-14T04-23-55-490Z_01a1d84c-3562-7411-ab1a-99a75488720a.jsonl` (record 6), with the run id and the word replaced. Its `content` also holds the skill text with the literal placeholder row `|`worker`|`<run> <step>`|`.
  - Codex (variant (b)): the prompt records are `response_item` records of `payload.type: "message"`. Codex writes injected context as `user` records, each `payload.content` an array of `{ type: "input_text", text }`, such as `<recommended_plugins>…` and `<environment_context>…`, and the real prompt follows them. The fixture puts both injected records before the prompt, and the spec line in the first `user` record after those, `payload.role: "user"`. Seen in a real rollout, `~/.codex/sessions/2026/07/18/rollout-2026-07-18T09-11-31-019f75ff-45cc-7451-9d56-baf33c957c42.jsonl.zst`: the first `user` record is `<recommended_plugins>…` and the real prompt is the second; a first-user-record reader never sees the prompt.
- Session files with the run's worktree as `cwd` and a different known cost each:
  - V: validator. Starts before `check` has `step.started` (in the gap after `build`), with `worker <run id> check` in its prompt records. No window holds it.
  - W: test case writer. Starts inside the window of `build` in the same worktree, with `worker <run id> test-case-writer` in its prompt records. Without the spec line the window rule would give it to `build`.
  - P: a session in no window. Its prompt records hold only the placeholders: the real `skill-prompt` text of an omp run lead head, which has the `ark` skill table row `|`worker`|`<run> <step>`|` and the line `=== TASK === run-lead <run id>`, plus `/skill:ark worker <run> check` and `<run> test-case-writer` (as in the run lead playbook), with the literal `<run>`.
  - O: a session in no window. Its prompt records hold a spec line with the id of another run and the step `check`.
  - O2: a session in no window. Its prompt records hold a spec line whose run id extends this run id (`<run id>0`: for this run `2026-11-13-ARK-460-1` the other run `2026-11-13-ARK-460-10`) and the step `check`.
  - L: the run lead, with no spec line of this run.
- The spec line sits inside a JSON string, so `\n` follows it as two characters, and the step word must stop there.
- Variants: (a) a step id with punctuation, such as `check-2`, whose line must match the whole id and not a prefix (`check` must not take a `check-2` line); (b) the session V as a Codex `.zst` file in the shape above, with the `<recommended_plugins>` and `<environment_context>` user records before the prompt; (c) a spec line with the word of a step that never started places nothing.

## Steps

1. Run `ark retro <run>` and read its exit code.
2. Read `cost.by_step`, `cost.by_role` and the `actual_models` of `build` and `check` in `metrics.json`.
3. Read the cost line of unassigned files in the output.

## Expected results

- Exit 0.
- V adds its cost to `cost.by_step.check` and to `cost.by_role.validator`, and its model is in the `actual_models` of `check`.
- W adds its cost to `cost.by_role.test_writer` and `cost.by_step.orchestration`; it adds nothing to `cost.by_step.build`, `cost.by_role.implementer` or the `actual_models` of `build`.
- P, O and O2 stay unassigned: their cost is under `unassigned` in `cost.by_role` and `cost.by_step`, and the output names the three files. O2 shows that the match stops at the end of the run id.
- `cost.by_role.orchestration` is the cost of L only.
- Variant (a): the `check` line does not place a `check-2` session, and the other way round.
- Variant (b): V as a `.zst` file gives the same result as the omp file.
- Variant (c): the session stays unassigned.

## Screenshot checkpoints

None. The surface is CLI output and JSON; no screenshot applies.
