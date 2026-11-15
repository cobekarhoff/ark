---
id: ARK-T678
title: ARK-T678 `criteria accept --criteria` refuses an unknown key, a duplicate id, an unknown method, an empty or unreadable file, an empty verified_by on a test criterion, a wrong phase and a non-accept answer, and writes nothing
level: integration
technique: equivalence classes of invalid files and of invalid gate states, boundary values (empty list, one bad entry among valid ones, the same id in two forms), state transition (phase and answer)
priority: high
risk: "The writer replaces the `acceptance_criteria` block before it validates, so a refused file still leaves a changed ticket (a valid first entry lands, or the block is emptied); the strict reader is missing, so an unknown key or `manual: true` passes silently and the criterion becomes `method: test`; a duplicate is missed because `AC1` and `ARK-901-AC1` differ as strings; `--criteria` with `edit` or `abort` is ignored or closes the run; a file name that exists only in the cwd is read instead of the run folder"
status: active
changed_by: 2026-11-14-ARK-488-1
---

## Objective

Prove that each invalid `--criteria` use exits 1 with one `ark: <reason>` line that names the cause, and that `ticket_file`, `<run folder>/ticket.md` and `events.ndjson` (line count and bytes) are unchanged afterwards, and the phase is unchanged. Serves ARK-488/AC1 (each refusal; "writes nothing").

The write itself is ARK-T677; accept without the flag is ARK-T679. Existing proof misses this: the no-flag refusals in `test/gate.test.ts` (`at least one`, empty `verified_by`) run after the ticket is read, so they cannot show that a refused file wrote nothing. One case owns the refusal contract, at the `ark` process, with a table of files.

## Preconditions

- As ARK-T677: a temp `ARK_HOME`, project `demo`, ticket `ARK-901` written with `writeTicket("demo", "ARK-901", [])` and started with `ark run start`, then `recordEvaluation`, so the run is in `awaiting_criteria` (a ticket that holds a criterion at `run start` would be in `planning` after `recordEvaluation`). Then the ticket file is rewritten by hand to one existing criterion (`id: AC1`, `text: "old"`, `method: test`, `verified_by: [ARK-T1]`) and a body table. cwd is `<run folder>/workspace`.
- Before each probe: the bytes of `ticket_file` and of `<run folder>/ticket.md`, the line count and bytes of `events.ndjson`, and the phase.
- Criteria files in the run folder, each a mapping with `acceptance_criteria` unless said:
  - `unknown-key.yml`: valid entries and one entry with the extra key `owner: me`.
  - `top-key.yml`: valid, plus a top-level key `note: x`.
  - `manual.yml`: one entry with `manual: true` and no `method`.
  - `dup.yml`: `AC1` and `ARK-901-AC1` (the same criterion in two forms); and `dup-same.yml`: `AC1` twice.
  - `method.yml`: one entry with `method: review`.
  - `empty-list.yml`: `acceptance_criteria: []`; `no-key.yml`: a mapping without the key; `empty.yml`: an empty file; `bare-list.yml`: a top-level list; `syntax.yml`: text that is not valid YAML.
  - `no-text.yml`: an entry without `text`; `bad-verified.yml`: `verified_by: ARK-T1` (a string, not a list).
  - `test-empty.yml`: a valid `AC1` with `text: "new-first"` first, then `AC2` with `method: test` and no `verified_by`, and a variant with `verified_by: []`.
  - `good.yml`: valid, used for the phase and answer probes.
  - A `cwd-only.yml` that exists in `<run folder>/workspace` and not in the run folder.

## Steps

1. For each invalid file above run `ark gate record <run> criteria accept --criteria <file>`, comparing the preconditions' snapshot after each.
2. Run it with `--criteria does-not-exist.yml`, and with `--criteria cwd-only.yml`.
3. With `good.yml`: run `criteria edit --criteria good.yml` and `criteria abort --criteria good.yml` in `awaiting_criteria`.
4. With `good.yml`: run `gate record <run> plan approve --criteria good.yml` in `awaiting_criteria`.
5. Accept the criteria without the flag (so the run is in `planning`), snapshot again, then run `criteria accept --criteria good.yml`.

## Expected results

- Every refusing run (steps 1 to 4, and the last accept of step 5): exit 1; stderr holds one `ark: ` line with the reason; stdout shows no success line; `ticket_file`, `ticket.md` and `events.ndjson` are byte for byte the snapshot taken before that run; no new file in the run folder or the tickets folder.
- Step 1: the line names the cause: `unknown-key.yml` the key `owner`; `top-key.yml` the key `note`; `manual.yml` the key `manual`; `dup.yml` and `dup-same.yml` the duplicate criterion id (both forms count as the same id); `method.yml` the criterion and `review`, and lists the legal methods; `empty-list.yml`, `no-key.yml`, `empty.yml` that the file holds no criteria; `bare-list.yml` and `syntax.yml` that the file is not a mapping with `acceptance_criteria`; `no-text.yml` the entry that needs `id` and `text`; `bad-verified.yml` that `verified_by` must be a list. `test-empty.yml` (both variants) names `AC2` and the empty `verified_by` of a `method: test` criterion, and the text `new-first` of its valid first entry is not in `ticket_file` (the whole file is validated before the first byte is written); `ticket_file` still holds `AC1` with `old`.
- Step 2: both lines name the path that was not found, and say it is looked up in the run folder; the file that exists only in the cwd is not read.
- Step 3: `edit` and `abort` with `--criteria` exit 1 and the line names `--criteria` as valid only for `criteria accept`; the phase stays `awaiting_criteria` (`abort` does not close the run, `edit` is not silently accepted with the flag ignored).
- Step 4: exit 1 and the line names `--criteria`; the plan gate is not answered.
- Step 5: the accept without the flag exits 0, appends `criteria.updated` and `gate.answered`, and moves to `planning`; the snapshot for the refusal is taken after it. The accept with `--criteria good.yml` in `planning` exits 1 and the ticket, the run folder copy and the events are as after the first accept.

## Screenshot checkpoints

None. The surface is the `ark` command's exit code, stderr and files; no screenshot applies.
