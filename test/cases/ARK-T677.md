---
id: ARK-T677
title: ARK-T677 `ark gate record <run> criteria accept --criteria <file>` writes the file's criteria into the ticket_file block, copies the ticket to the run folder and records the gate
level: integration
technique: equivalence classes on the form of the existing `acceptance_criteria` block in the ticket file, on the three id forms and on the path form of the flag, plus state transition (awaiting_criteria to planning)
priority: high
risk: The writer drops or duplicates a front matter line it did not read (`status:`, `source:`), leaves the old block or a trailing comment next to the new one, breaks a text with a colon or a quote, rewrites the body, resolves a bare file name against the cwd (the lead's `workspace` folder) instead of the run folder, or lets `<run folder>/ticket.md` differ from `ticket_file`; the lead then accepts criteria that the plan does not see
status: active
changed_by: 2026-11-14-ARK-488-1
---

## Objective

Prove that `ark gate record <run> criteria accept --criteria <file>` takes the acceptance criteria (id, text, method, verified_by) from the YAML file, replaces the `acceptance_criteria` block of the `ticket_file` named in `run.started` and nothing else, copies `ticket_file` to `<run folder>/ticket.md`, and records the gate as `accept` does today. Serves ARK-488/AC1 (the write).

The refusals are ARK-T678; accept without the flag is ARK-T679. Existing proof misses this: `test/gate.test.ts` accept writes nothing itself, it only re-reads what the lead edited by hand, so no test fails if the writer corrupts the ticket. This case owns the write; it needs no test-only hook, because it runs the `ark` process and reads the files it leaves.

## Preconditions

- A temp `ARK_HOME` and project `demo` as in `test/gate.test.ts`; the ticket `ARK-901` written by `writeTicket("demo", "ARK-901", [])` and started with `ark run start`, then `recordEvaluation`, so the run is in phase `awaiting_criteria`.
- The ticket file is then rewritten by hand to one of these block forms, each with `status: ready` and a `source: cortana` line outside the block, one line of body text, and a body table `## Acceptance criteria` whose rows hold an old text:
  a. `acceptance_criteria: []`;
  b. the key absent;
  c. a block list with a trailing comment on one line and a `verified_by: [ARK-T1]` flow list;
  d. a block list that is the last front matter key, and the same block followed by another key (`milestone: M5`).
- A criteria file `<run folder>/criteria.yml`: a mapping with `acceptance_criteria` of three entries: `AC1` with `method: test` and `verified_by: [ARK-T10, ARK-T11]`; `ARK-901-AC2` with `method: inspection`, no `verified_by`, and a text that holds a colon, a double quote and a `#`; `ARK-901/AC3` with `method: demonstration` and `verified_by: []`. The three ids are in the three forms the ticket loader accepts (`AC<k>`, `<ticket>-AC<k>`, `<ticket>/AC<k>`).
- The cwd of the `ark` process is `<run folder>/workspace`, as the run lead's is.

## Steps

1. For each ticket form a to d, reset the run to `awaiting_criteria` (a fresh run for each form) and run `ark gate record <run> criteria accept --criteria criteria.yml --note "looks right"` (a bare name, from the cwd above). Keep the criteria file bytes and the ticket file bytes from before.
2. Read `ticket_file`, `<run folder>/ticket.md`, the criteria file, `events.ndjson` and `state.json`. List the files in the tickets folder and the run folder.
3. Parse the new `ticket_file` with the front matter reader that `ark run start` uses (`frontmatter` and `parseCriteria` of `cli/ticket.ts`) and compare the list with the criteria file.
4. In a fresh run, with form c, run the same command with the absolute path of `criteria.yml`.

## Expected results

- Steps 1 and 4: exit 0 for every form and for both path forms; stdout is whatever `accept` prints today.
- `ticket_file`: every line outside the `acceptance_criteria` block is byte for byte what it was (the `id`, `title`, `status: ready`, `source: cortana`, `milestone: M5` where present, the `---` fences and the body, the body table still holding the old text); the block exists once, in the place the old block was (at the end of the front matter, or before `milestone: M5`); no line of the old block, no trailing comment of it, and no `acceptance_criteria: []` remains.
- Step 3: the list parsed from `ticket_file` equals the criteria file's list: three criteria with ids `ARK-901/AC1`, `ARK-901/AC2`, `ARK-901/AC3`, methods `test`, `inspection`, `demonstration`, `verified_by` `[ARK-T10, ARK-T11]`, `[]`, `[]`, and the text of AC2 equal to the file's, character for character.
- `<run folder>/ticket.md` is byte for byte `ticket_file`.
- `events.ndjson` gains exactly two events, in order: `criteria.updated` with `criteria` equal to the three ids in the file's order, then `gate.answered` with `{ gate: "criteria", answer: "accept", by: "human", note: "looks right" }`. `state.json` has phase `planning`, `gates.criteria` `accept` and the three criteria.
- The criteria file is byte for byte what it was. No other file appears in the tickets folder or the run folder (no temporary or backup file).

## Screenshot checkpoints

None. The surface is the `ark` command's files and exit code; no screenshot applies.
