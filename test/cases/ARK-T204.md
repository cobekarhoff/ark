---
id: ARK-T204
title: ARK-T204 --json prints the inventory rows as JSON and --summary prints the counts by file and by id kind and the total test lines
level: integration
technique: equivalence classes over output mode (table, json, summary) with one fixture; consistency between modes
priority: medium
risk: "the JSON rows differ from the table rows, a summary count disagrees with the rows (a kind miscounted, a file missing, the total off by the each rows), or --json and --summary together give unreadable output"
status: active
changed_by: 2026-11-10-ARK-384-1
---

## Objective

Prove that `--json` carries the same rows as the default output, and that `--summary` counts them by file and by id kind.

Expected: When --json is given, the command shall print the same rows as JSON. When --summary is given, the command shall print the count for each file, the count for each id kind (case id, old AC id, none) and the total test lines.

## Preconditions

- Fixture project of ARK-T203, with its ticket links (`ARK-T1` verified ACs `ARK-900/AC1`, `ARK-900/AC2`, `ARK-901/AC1`); counts by kind and by file are fixed in the fixture.

## Steps

1. Run with `--json`; parse the stdout as JSON.
2. Compare each parsed row (file, line, title, id kind, id, ACs, duration) with the row of the default output; the ACs of the `ARK-T1` row are the same three ticket-linked ids in both modes.
3. Run with `--summary`; read the counts.
4. Sum the counts of the rows by file and by kind from step 1 and compare with step 3.

## Expected results

- The JSON is one valid document whose rows equal the default rows in number, order and every field; a missing duration is absent or null, never a made-up value.
- The summary lists each file with its count, the three kinds with their counts, and the total; the sum by file, the sum by kind and the total are equal and equal the row count.
- The commands exit 0 and print nothing else on stdout.

## Screenshot checkpoints

none: the surface is CLI output, which the test reads as text.
