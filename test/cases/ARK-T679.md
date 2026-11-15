---
id: ARK-T679
title: ARK-T679 `criteria accept` without `--criteria` still re-reads the hand-edited ticket, accepts old-shape criteria and writes nothing to it
level: integration
technique: characterization of today's behavior with boundary values (the old `manual: true`, an unknown criterion key) and state transition (awaiting_criteria to planning)
priority: high
risk: The strict reader of the new file leaks into `parseCriteria` or into the no-flag path, so a ticket with `manual: true` or an extra criterion key is refused at accept, or the no-flag accept starts to write `ticket_file`
status: active
changed_by: 2026-11-14-ARK-488-1
---

## Objective

Prove that `ark gate record <run> criteria accept` with no `--criteria` behaves as at base: it reads the ticket file named in `run.started`, accepts the shapes the lenient ticket reader accepts (`manual: true` as `demonstration`, an unknown key in a criterion), copies the file to `<run folder>/ticket.md`, leaves `ticket_file` untouched, and records `criteria.updated` then `gate.answered`. Serves ARK-488/AC1 (an accept without the flag keeps today's behavior).

Existing proof, `test/gate.test.ts` "criteria accept re-reads the ticket, needs one criterion" (line 112) and "ARK-311-AC5 accept refuses a new-scheme method test AC with an empty verified_by, names the AC id" (line 457), owns the plain re-read and the two no-flag refusals (no criteria; `method: test` with an empty `verified_by`) with a clean ticket, through the `ark` process. They stay; this case adds none of them. They do not read an old-shape ticket or check that the accept leaves `ticket_file` untouched, which is what a stricter reader or a writer in the shared path would break. This case adds only those.

## Preconditions

- As ARK-T677: temp `ARK_HOME`, project `demo`, ticket `ARK-901` written with `writeTicket("demo", "ARK-901", [])`, started and evaluated (`recordEvaluation`), so the phase is `awaiting_criteria`.
- The ticket file hand-edited to: `AC1` with `method: test` and `verified_by: [ARK-T1]`; `AC2` with `manual: true` and no `method`; `AC3` with `method: inspection` and an unknown key `owner: me`. The three ids in the forms `ARK-901-AC1`, `ARK-901-AC2`, `ARK-901-AC3`.
- A criteria file `<run folder>/criteria.yml` with different criteria exists in the run folder but is not passed.

## Steps

1. Record the bytes of `ticket_file`. Run `ark gate record <run> criteria accept --note "ok"` (no `--criteria`).
2. Read `ticket_file`, `<run folder>/ticket.md`, `events.ndjson` and `state.json`.

## Expected results

- Step 1: exit 0.
- Step 2: `ticket_file` is byte for byte what it was; `ticket.md` is byte for byte `ticket_file`; `criteria.updated` lists `ARK-901/AC1`, `ARK-901/AC2`, `ARK-901/AC3` and is followed by `gate.answered` `{ gate: "criteria", answer: "accept", by: "human", note: "ok" }`; the phase is `planning`; `<run folder>/ticket.md`, read with `frontmatter` and `parseCriteria` of `cli/ticket.ts`, gives `AC2` method `demonstration` and `AC3` method `inspection`; the criteria in `criteria.yml` appear nowhere.

## Screenshot checkpoints

None. The surface is the `ark` command's exit code, stderr and files; no screenshot applies.
