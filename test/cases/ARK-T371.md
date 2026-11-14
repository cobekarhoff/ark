---
id: ARK-T371
title: ARK-T371 Home shows the tile strip first, then the blockers, the review queue in merge order and the progress and usage, with Master Chief once
level: e2e
technique: equivalence classes of Home section (tiles, blockers, reviews, progress, usage, nav); order checks on layout
priority: high
risk: "Home puts a column above the tile strip or out of order, lists the review queue out of merge order, shows a wrong count, CI, test, finding, diff or wait value on a review row (a finding the run lead dropped with a `- dropped <title>: <reason>` line still counted in `P1 n · P2 n · P3 n`), hides the stuck agent's last line or Open in Orca, or shows Master Chief twice or marked configured"
status: active
changed_by: 2026-11-14-ARK-391-1
---

## Objective

Prove that Home with a gate, a stuck agent, two merge requests and an 82% usage window shows the tile strip first and then three columns with the right content.

Expected: Home shall show the tile strip above three columns, the review queue oldest merge request first, and Master Chief once.

## Preconditions

- One gate (ARK-501), one stuck run waiting on a prompt, two runs in review (an older and a newer merge request with different CI, tests, findings and diffs), 4 open runs, and a usage window at 82%.
- The older run's findings file holds `### P1: a`, `### P1: vague`, two P2 and one P3 headings, and a `## Run lead decision` section with `- dropped vague: no Input`. The newer run's file has two P1 headings and no decision section.
- Master Chief set in `ark.yml`. The page and the fixtures share the frozen instant 12:00 UTC, so the reset reads `resets HH:MM`.

## Steps

1. Open Home.
2. Read the 6 tiles and their values; compare the position of the strip with the 3 columns.
3. Column 1: read the gate and the stuck agent (run, last line, Open in Orca).
4. Column 2: read the order of the review rows and, for each, CI, tests, findings (a P1 with a `dropped` line is not counted) and findings link, diff, wait and AC squares.
5. Column 3: count the progress rows; read the usage window and its reset; read the usage tile class.
6. Count "Master Chief" in the page and in the header; count "(configured)".

## Expected results

- 6 tiles: Needs me 1, Reviews 2, Runs 4, Stuck 1, usage 82%; 3 columns left to right below the strip.
- Gate ARK-501; the stuck agent shows its run, "waiting on a prompt", the last command and Open in Orca.
- Reviews: older first; CI passing then failing; tests "6 pass · 0 fail" and "2 pass · 1 fail"; findings "P1 1 · P2 2 · P3 1" (the P1 with a `dropped` line is not counted, so two P1 headings show P1 1) and "P1 2 · P2 0 · P3 0" (no dropped line, both counted); diffs "+312 −41 · 6 files" and "+158 −22 · 4 files"; waits about 3 h and about 20 min; 3 and 2 AC squares, the second AC of the newer one failing.
- 4 progress rows; usage window near the limit at 82%, reset `resets HH:MM`, usage tile alarm.
- "Master Chief" once, in the header; no "(configured)".

## Screenshot checkpoints

none: the case checks text, counts, order and attributes, not appearance.
