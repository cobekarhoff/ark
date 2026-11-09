---
id: ARK-T148
title: ARK-T148 the band lists the escaped defects of this run from escaped-defects.yml and nothing for a run with none
level: integration
technique: equivalence classes (entries for this run, entries only for other runs, no file or malformed file)
priority: medium
risk: the band lists defects of other runs, reads `metrics.escaped_defects` instead of the file (misses a defect found after close), drops the note or fix, renders note text as HTML, or a missing or malformed file breaks the page
status: active
changed_by: 2026-11-09-ARK-353-1
---

## Objective

Prove that the band shows exactly this run's entries of `escaped-defects.yml`, read when the detail opens.

## Preconditions

- A hub started on a scratch `ARK_HOME` with real run folders (events, `state.json`, files), real snapshot and `runDetail()` code, and a real browser (Playwright, `test/pw/hub.pw.ts`). No mocks of the page or of the snapshot.
- `escaped-defects.yml` in the project folder with 2 entries for run A (ticket, note, fix; one note holds `<b>x</b>`) and 1 entry for run B.
- Run A's `metrics.json` has `escaped_defects` 0 (written at close, before the defects were found).
- Run C has no entry.

## Steps

1. Open the page of run A and read the defect list.
2. Open run C and read the band.
3. Replace the file with malformed YAML, reload run A.
4. Remove the file, reload run A.

## Expected results

- Run A's band shall list its 2 entries, each with ticket, note and fix, and not run B's entry.
- The note with `<b>x</b>` shall show as literal text.
- Run C's band shall show no defect list and no empty heading.
- With a malformed or missing file the band shall show no defect list and the page shall still load.

## Screenshot checkpoints

Band of run A with the defect list; band of run C without.
