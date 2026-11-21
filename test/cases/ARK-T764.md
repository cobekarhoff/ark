---
id: ARK-T764
title: "ARK-T764 the criteria gate writes guard: true into the ticket and the event, and refuses it on a criterion whose method is not test, in a run that is not a bug run, and with a value that is not a boolean, on both accept paths"
level: integration
technique: equivalence classes of the guard value (true, false, absent, a string) and of the criterion and run it sits on (test in a bug run, inspection or manual in a bug run, test in a feature or refactor run), over both ways into the criteria gate (accept with --criteria, accept that re-reads the hand-edited ticket)
priority: high
risk: 'the strict criteria-file reader still refuses `guard` as an unknown key, or the writer drops it so ticket.md and criteria.updated never carry it (the red proof then demands the guard and the run is rewritten as in ARK-606); or the read-back check of accept compares a list without the key and refuses every guard file; or the lenient ticket reader (`parseCriteria`) drops the key on the no-flag path; or a guard on an inspection AC or in a feature run is accepted silently, so a run believes it has an exemption that the red proof never uses; or the refusal is checked on one accept path only; or the string `"false"` is read as truthy and marks a guard; or a refused file still writes the ticket or the log'
status: active
changed_by: 2026-11-21-ARK-617-1
---

## Objective

Prove that `ark gate record <run> criteria accept`, with `--criteria <file>` and without it, carries `guard: true` of a criterion into `ticket_file`, `<run folder>/ticket.md` and the `criteria.updated` event, and refuses `guard: true` on a criterion whose method is not `test` and in a run whose kind is not `bug`, with one `ark: ` line that names the AC, writing nothing. Serves ARK-617/AC1 (the criteria gate).

Authoring gate:

1. Protects: the criteria gate's reading and writing of the new key (`cli/criteria.ts` strict reader, writer and read-back; `parseCriteria` of `cli/ticket.ts`; the `criteria.updated` event) and its two refusals.
2. Fails when: the strict reader or the writer drops or refuses `guard` (step 1), the event lacks the guard (step 1), the no-flag path loses it (step 5), a refusal is missing on either path or names no AC (steps 2, 3, 6), `"false"` or `"yes"` marks a guard on either path (steps 4 and 6), or a refusal writes the ticket or the log (steps 2 to 4, 6).
3. Existing proof misses it: ARK-T677 owns the write of the four old keys, ARK-T678 the refusals of other keys (an unknown key such as `owner: me` stays refused), ARK-T679 the lenient no-flag path; none has a `guard` key. They stay as they are. This case adds the new key on both paths; the red proof that reads the event is ARK-T763.
4. No test-only export, flag or hook: the case runs the `ark` process and reads the files it leaves; `parseCriteria` is read only to check what the readers of the ticket see, as ARK-T677 does.

## Preconditions

- As ARK-T677 and ARK-T678: a temp `ARK_HOME`, project `demo`, a ticket started with `ark run start` and evaluated (`recordEvaluation`) with no criteria, so the run waits in `awaiting_criteria`; cwd `<run folder>/workspace`. A `kind: bug` ticket `ARK-901`, and two more tickets that differ only in kind: `ARK-902` with `kind: refactor` and `ARK-903` with no `kind` line (a feature run).
- Before each refused call: the bytes of `ticket_file` and `<run folder>/ticket.md`, the line count and bytes of `events.ndjson`, and the phase.
- Criteria files in the run folder, each a mapping with `acceptance_criteria`:
  - `good.yml`: `AC1` `method: test` with `verified_by: [ARK-T10]` and no `guard`; `AC2` `method: test` with `verified_by: [ARK-T11]` and `guard: true`; `AC3` `method: inspection`.
  - `false.yml`: as `good.yml` with `guard: false` on `AC2`.
  - `on-inspection.yml`: as `good.yml` plus `guard: true` on `AC3`.
  - `string.yml`: as `good.yml` with `guard: "false"` on `AC2`; `yes.yml` with `guard: "yes"`.

## Steps

1. Bug run `ARK-901`: run `ark gate record <run> criteria accept --criteria good.yml`. Read `ticket_file`, `<run folder>/ticket.md`, the last `criteria.updated`, and the criteria parsed from `ticket.md` with `frontmatter` and `parseCriteria` of `cli/ticket.ts`.
2. Fresh bug run: accept with `on-inspection.yml`.
3. The refactor run `ARK-902` and the feature run `ARK-903`: accept with `good.yml`.
4. Fresh bug runs: accept with `string.yml`, then with `yes.yml`; a fresh bug run with `false.yml`.
5. No-flag path, bug run: hand-edit the ticket file to the criteria of `good.yml` (block form, `guard: true` on `AC2`). Run `ark gate record <run> criteria accept` with no `--criteria`. Read the same files and event as step 1.
6. No-flag path refusals: a bug run whose hand-edited ticket has `guard: true` on an `inspection` AC; another whose `AC2` has `manual: true` and `guard: true` (read as `demonstration`); another whose `AC2` has `guard: "false"` (a quoted string); the feature run `ARK-903` with the ticket of step 5. Run accept with no `--criteria` in each.

## Expected results

- Step 1: exit 0. `ticket_file` and `ticket.md` hold `guard: true` in the block of `AC2` only; `ticket.md` is byte for byte `ticket_file`; the lines outside the `acceptance_criteria` block are as ARK-T677 says. The parsed criteria give `AC2` guard true and `AC1`, `AC3` no guard. `criteria.updated` lists the three ids and names `ARK-901/AC2`, and only it, as a guard (`guards: ["ARK-901/AC2"]`). The phase is `planning`.
- Step 2: exit 1; one `ark: ` line that names `AC3`, `guard` and its method `inspection`; nothing written (snapshot unchanged, phase `awaiting_criteria`).
- Step 3: exit 1 in both runs; the line names `AC2`, `guard` and the run's kind (`refactor`, `feature`); nothing written.
- Step 4: `string.yml` and `yes.yml` exit 1 with a line that names `AC2` and `guard` and says it must be `true` or `false`; nothing written. `false.yml` exits 0 and `criteria.updated` names no guard; `AC2` parsed from `ticket.md` has no guard.
- Step 5: exit 0; `ticket_file` is byte for byte what it was (the no-flag path writes nothing to it, as ARK-T679); `ticket.md` holds the `guard: true` line; `parseCriteria` gives `AC2` guard true; `criteria.updated` names `ARK-<id>/AC2` as the only guard.
- Step 6: each accept exits 1 with one `ark: ` line that names the AC and `guard` (with the method `inspection` or `demonstration`, the kind `feature`, or, for `guard: "false"`, that it must be `true` or `false`); `events.ndjson` gains no event and the phase stays `awaiting_criteria`.

## Screenshot checkpoints

none: the surface is the `ark` command's exit code, stderr and files; no UI surface.
