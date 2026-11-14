---
id: ARK-T376
title: "ARK-T376 ark retro gives each run lead, test case writer, test case reviewer and implementer session its own by_role entry, with nothing unassigned and the roles adding up to the total"
level: integration
technique: "equivalence classes on session owner (run lead, writer, reviewer, step) in one run; invariant (sum of roles equals total)"
priority: high
risk: "a test case session, or a second session no one can place, still counts as orchestration, so the run lead cost in by_role is too high; a test case session is left unassigned or taken as the run lead; a role entry or an empty unassigned key is missing or invented; the roles do not add up to cost.total_usd because a message counts twice or not at all; the real run lead is left unassigned because the writer was the earliest lead candidate and the lead slot is taken before the spec line is read; a spec line in a later worker-start call of the run lead (after its first assistant record) turns the run lead into test_writer; the reader looks only at a user record and so misses the spec line, which a real omp worker session holds in a custom_message record"
status: active
changed_by: 2026-11-13-ARK-460-1
---

## Objective

Prove that `ark retro` writes `cost.by_role` with the cost of each session under its own role when the run has a run lead, a test case writer, a test case reviewer and an implementer session. Serves ARK-460/AC1.

Expected: When a run has one run lead, one test case writer, one test case reviewer and one implementer session, the system shall put each session cost under `orchestration`, `test_writer`, `test_reviewer` and `implementer`, with no `unassigned` entry, and the roles shall add up to `cost.total_usd`.

## Preconditions

- A temporary `ARK_HOME` with a closed run: one implementer step with `step.started` and `step.finished`, and a `worker.started` event for it that names its session file.
- "Prompt records" of a session means every record before its first assistant record (an omp `message` record with `message.role` `assistant`). Only these are read for the spec line. In a real omp session they are, in order: `session`, `model_change`, two `thinking_level_change`, a `custom` `date-cwd-reminder`, the `custom_message` below, and a `custom` `system-prompt-digest`; the first assistant record follows. Checked against the heads in `~/.omp/agent/sessions/-.ark-projects-ark-runs-2026-11-13-ARK-460-1-workspace/` (for example `2026-11-14T04-23-55-490Z_01a1d84c-3562-7411-ab1a-99a75488720a.jsonl`: records 0 to 7 are prompt records, record 8 is the first assistant record).
- Real omp record shape of the spec line. The worker prompt is not a user record. It is one `custom_message` record with `customType: "skill-prompt"`, `display: true`, and:
  - `content`: the whole `ark` skill text, then the task text, which holds the line `=== TASK === worker <run id> <word>` and goes on with the task;
  - `details`: `{ name: "ark", path, args, prompt, lineCount }`, where `args` holds `=== TASK === worker <run id> <word>` and `prompt` holds `=== TASK ===` and then, on its own line, `/skill:ark worker <run id> <word>`.
    The fixtures copy this record from a real head, with the run id and the word replaced. The skill text in `content` already holds placeholder lines such as the table row `|`worker`|`<run> <step>`|` with the literal `<run>`; those stay in the copy.
- Four OMP session files with the run's worktree as `cwd` and a different known cost for each, so that a wrong role gives a wrong number:
  - Run lead: starts before the first step and is written at or after it. Its `skill-prompt` record has `=== TASK === run-lead <run id>` and no worker spec line.
  - Test case writer: starts before the plan (before the first step, after the run lead). Its `skill-prompt` record carries `worker <run id> test-case-writer` in `content`, `args` and `prompt`, with the real run id.
  - Test case reviewer: starts before the first step. Its `skill-prompt` record carries `worker <run id> test-case-reviewer`.
  - Implementer: starts inside the step window and is named by `worker.started`.
- The writer and the reviewer start after the run lead, so only the spec line, not the start time, tells the three apart from a run lead candidate.
- Second run of the same fixture, writer first: the writer starts before the run lead and is last written at or after the first step (`step.started`). It is then the earliest lead candidate, and only its spec line keeps it out of the lead slot. The run lead is still the file with no spec line of its own and is the next candidate. A writer last written before the first step could never be a lead candidate, so it would not test this.
- Third run of the same fixture, run lead with a spec line after its prompt records: after its `skill-prompt` record (no worker spec line) and its first assistant record, the run lead file holds a later assistant record with a `toolCall` of `orca orchestration worker-start --spec "... worker <run id> test-case-writer ..."` and the matching `toolResult`, inside the first 64 KiB. This is what the run lead writes when it starts the writer. The run lead stays the earliest-starting candidate.

## Steps

1. Run `ark retro <run>` and read its exit code.
2. Read `cost.by_role`, `cost.by_step`, `cost.total_usd` and `master_chief_and_run_lead_cost` in `metrics.json`.
3. Read the cost line of unassigned files in the output.

## Expected results

- Exit 0.
- `cost.by_role.orchestration` is the cost of the run lead file only; `test_writer` is the cost of the writer file; `test_reviewer` is the cost of the reviewer file; `implementer` is the cost of the implementer file.
- `master_chief_and_run_lead_cost` is the cost of the run lead file only, so it equals `cost.by_role.orchestration`.
- Neither `cost.by_role` nor `cost.by_step` has an `unassigned` key.
- `cost.by_step.orchestration` holds the run lead, the writer and the reviewer; `cost.by_step.<implementer id>` holds the implementer file only.
- The sum of the `cost.by_role` costs equals `cost.total_usd`.
- The output has no `unassigned:` line.
- With the writer first and last written at or after the first step (second run of the fixture), the same keys and costs result: the run lead is `orchestration`, not `unassigned`, and the writer is `test_writer`.
- With the spec line after the first assistant record of the run lead (third run of the fixture), the same keys and costs result: the run lead stays `orchestration` and nothing goes to `test_writer` from it. Only the prompt records count, not the whole 64 KiB head.

## Screenshot checkpoints

None. The surface is CLI output and JSON; no screenshot applies.
