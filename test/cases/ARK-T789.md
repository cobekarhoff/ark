---
id: ARK-T789
title: "ARK-T789 the evidence missing line names the file it looked for, results/evidence/<AC id>.md, for each method, in ark merge-request check and in a validator step finish"
level: integration
technique: equivalence classes over method (analysis, inspection, demonstration) times command (check stage step, check stage final, run step finish), with the controls that an existing file, a malformed file and a test criterion print another line or none
priority: high
risk: "the refusal says only `evidence missing: AC3 (analysis)`, so a worker cannot tell where the file belongs and writes `results/evidence/<ticket id>/AC3.md` again (ARK-419 refused 3 times, ARK-423, ARK-572, ARK-613); or the path is spelled in a second place and drifts from `evidenceFile` (the canonical `FAKE-1/AC3` id leaks into the path, or the ticket folder is added); or only one command or method gets the text (finish reports only due analysis files, check reports all three methods)"
status: active
changed_by: 2026-11-21-ARK-626-1
---

## Objective

Prove that every `evidence missing` line of an `analysis`, `inspection` or `demonstration` criterion ends with `: expected results/evidence/<AC id>.md` (the path relative to the run folder, with the local AC id), on `ark merge-request check` and on `ark run step <run> <step> finish`. Serves ARK-626 AC1. `ark merge-request open` and `ark run close <run> handed_off` read the same line: ARK-T7 owns their text. This case owns the `expected` text of the line; ARK-T379, ARK-T380 and ARK-T7 quote it only because their whole-line comparisons need the new text, and ARK-T381 keeps its prefix assertion (`toContain`) and owns the finish refusal, not the text.

## Preconditions

- Check fixture: `syncedRun("feature", { verified: true, criteria, plan })` of `test/sync-base.test.ts` with a new criteria list (not `stageCriteria` of ARK-T379): ticket `FAKE-1`, `FAKE-1-AC1` (`method: analysis`), `FAKE-1-AC2` (`method: inspection`), `FAKE-1-AC3` (`method: demonstration`), `FAKE-1-AC4` (`method: test`, `verified_by: [FAKE-T1]`); the plan has an implementer step and a validator step `check` that serves all four; no evidence file at all; no `results/evidence/FAKE-1/` folder. The fake host of `test/fixtures/merge-request` is first on `PATH` and `ARK_HOME` is that of the fixture before each command.
- Finish fixture: the `ValidatorRun` fixture of `test/finish-validator-stage.test.ts` (ticket `ARK-900`): a validator step `val-2` that serves `AC3` with `method: analysis` (the only method that `finish` reports, `evidenceDue`), a clean worktree, no `AC3.md`, and `AC1` and `AC2` unserved.
- Before each command the test records the bytes of `events.ndjson` and a recursive listing of `results/` in the run folder.

## Steps

1. In the check fixture run `ark merge-request check <run> --stage step --step check`. Assert exit 1 and three separate lines, each once: `evidence missing: AC1 (analysis): expected results/evidence/AC1.md`, `evidence missing: AC2 (inspection): expected results/evidence/AC2.md` and `evidence missing: AC3 (demonstration): expected results/evidence/AC3.md`. The local id is `AC1`, never `FAKE-1/AC1`, and the path has no `FAKE-1` segment and no absolute prefix. No line for `AC4` (a test criterion needs no file).
2. Run `--stage final` in the same fixture. Assert the same three lines (final adds other lines, not pinned) and the same text for each.
3. Write a well-formed `AC1.md` (analysis) and re-run `--stage step --step check`: the `AC1` line is gone and the two others keep their text. Replace `AC2.md` by a malformed file (no `Verdict` section): the line for `AC2` is `evidence malformed: AC2: ...`, with no `expected` text (the new text belongs to the missing line only).
4. In the finish fixture run `ark run step <run> val-2 finish` (analysis `AC3`). Assert exit 1, stderr holds `evidence missing: AC3 (analysis): expected results/evidence/AC3.md`, `events.ndjson` has the same bytes (no `step.finished`), the step is still `running`, and `results/` has the same listing. (That finish exits 0 once the file is written, and that it does not refuse a demonstration or inspection file, stay with ARK-T381 steps 11 and 7; stage `head` printing no missing line stays with ARK-T379 step 1.)
5. After every command compare the record: `events.ndjson` is byte-identical for `check`, and no file is created at any path of the line.

## Expected results

- When an `analysis`, `inspection` or `demonstration` criterion has no evidence file, the system shall print `evidence missing: <AC id> (<method>): expected results/evidence/<AC id>.md` on its own line, in `ark merge-request check` (stage `step` and `final`) and in `ark run step ... finish` (analysis).
- The path shall be the one `evidenceFile` gives: local AC id, no ticket folder, relative to the run folder.
- A malformed file shall print `evidence malformed` with no `expected` text.
- The commands shall write no file and no event.

## Screenshot checkpoints

none: integration case on CLI output; no UI surface.
