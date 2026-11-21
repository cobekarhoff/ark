---
id: ARK-T790
title: "ARK-T790 when the evidence file sits under results/evidence/<ticket id>/, the missing line adds where it found it and says to move it, and nothing is moved"
level: integration
technique: equivalence classes over where a file sits (ticket folder of this ticket, ticket folder of another ticket, a folder named like the file, another AC's file, the file moved to the right path) with a state check that nothing moved
priority: high
risk: "the line does not name the misplaced file, so the worker is refused again (the ARK-419 file sat at `results/evidence/ARK-419/AC3.md`); or the hint names a path that is not a file (a folder `AC2.md/`, another ticket's folder, another AC's file), so the worker is sent to move nothing; or the hint shows when the file at the right path exists (after the move); or the check moves, copies or deletes the file, or writes an event, so a refusal changes the run"
status: active
changed_by: 2026-11-21-ARK-626-1
---

## Objective

Prove that when `results/evidence/<AC id>.md` is missing and the file `results/evidence/<ticket id>/<AC id>.md` exists in the run folder, the missing line adds `; found results/evidence/<ticket id>/<AC id>.md: move it to results/evidence/<AC id>.md`; that no other layout adds it; and that the command refuses and moves nothing. Serves ARK-626 AC2.

## Preconditions

- Check fixture: `syncedRun` of `test/sync-base.test.ts` with the criteria list of the check fixture of ARK-T789 (ticket `FAKE-1`, `FAKE-1-AC1` analysis, `FAKE-1-AC2` inspection, `FAKE-1-AC3` demonstration, `FAKE-1-AC4` test with `verified_by: [FAKE-T1]`; the validator step `check` serves all four; no step here asserts `AC4`, a test criterion has no file and no line), no file at `results/evidence/AC<k>.md`. The folder name is the ticket id, `FAKE-1`.
- Finish fixture: the `ValidatorRun` fixture of `test/finish-validator-stage.test.ts` (ticket `ARK-900`, validator `val-2` serves `AC3`, analysis, clean worktree). Ship fixture: `shipRun()` of `test/evidence-ship.test.ts` with an `inspection` criterion `AC1`, run through `ark merge-request open` (the `describe.each(commands)` loop also runs `ark run close <run> handed_off`).
- The test records, before each command, the bytes of `events.ndjson`, a recursive listing with file bytes of the whole `results/` folder, and (check, open) `git ls-remote origin`.

## Steps

1. In the check fixture write `results/evidence/FAKE-1/AC1.md`, `.../AC2.md` and `.../AC3.md` (any text: the found file is not read). Run `ark merge-request check <run> --stage step --step check`. Assert exit 1 and, each on its own line: `evidence missing: AC1 (analysis): expected results/evidence/AC1.md; found results/evidence/FAKE-1/AC1.md: move it to results/evidence/AC1.md`, and the same for `AC2` (inspection) and `AC3` (demonstration). Run `--stage final`: the same three lines.
2. Compare the record: the three files are still at `results/evidence/FAKE-1/`, no file exists at `results/evidence/AC<k>.md`, the listing and bytes are equal, `events.ndjson` is byte-identical, and the refusal is exit 1 again on a second run (the check moves nothing, so the hint is stable).
3. Layouts that add no hint (one at a time, ticket folder content reset; (d) starts from the layout of step 1): (a) the file is under another ticket's folder, `results/evidence/OTHER-9/AC1.md`: the line is the AC1 line of ARK-T789 with no `; found`; (b) `results/evidence/FAKE-1/AC1.md` is a folder (it holds a file): no `; found`; (c) `results/evidence/FAKE-1/AC2.md` exists and `AC1.md` does not: the `AC1` line has no `; found` and the `AC2` line has one; (d) the move that the line asks for: start from step 1's layout (all three files under `FAKE-1/`), replace `FAKE-1/AC1.md` by a well-formed analysis text, move it to `results/evidence/AC1.md` (`FAKE-1/AC1.md` is gone): the `AC1` line is gone and no `; found results/evidence/FAKE-1/AC1.md` text appears, while the `AC2` and `AC3` lines keep their hint (the instruction works); (e) the `FAKE-1` folder holds `base/` and `head/` test folders but no `AC1.md`: no `; found`.
4. Finish fixture: write `results/evidence/ARK-900/AC3.md`. Run `ark run step <run> val-2 finish`. Assert exit 1, stderr holds `evidence missing: AC3 (analysis): expected results/evidence/AC3.md; found results/evidence/ARK-900/AC3.md: move it to results/evidence/AC3.md`, `events.ndjson` has the same bytes (no `step.finished`), the step is still `running`, and the file is still at `results/evidence/ARK-900/AC3.md`.
5. Ship fixture: write `results/evidence/<ticket id>/AC1.md` (the inspection file, well-formed). Run `ark merge-request open <run>`. Assert it is refused with `refused: evidence is not complete` and the line with the `; found` text for `AC1`; remote refs are unchanged. The proof that the hint comes from the one line builder in a second command, not a copy.

## Expected results

- When `results/evidence/<AC id>.md` is missing and `results/evidence/<ticket id>/<AC id>.md` is a file, the system shall add `; found results/evidence/<ticket id>/<AC id>.md: move it to results/evidence/<AC id>.md` to the same line, after the `expected` text of ARK-T789.
- The system shall add the hint for no folder, no other ticket's folder, no other AC's file and no layout where the file at the right path exists; the move that the line asks for clears the line.
- The check shall refuse as it did and shall move, copy, delete or write nothing: the files, the listing and `events.ndjson` are unchanged.
- The line shall be the same on `check`, on `ark run step ... finish` and on `ark merge-request open`.

## Screenshot checkpoints

none: integration case on CLI output and run-folder files; no UI surface.
