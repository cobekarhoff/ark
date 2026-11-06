---
id: ARK-T6
title: ARK-T6 evidence file shape of each method is checked
level: integration
technique: equivalence classes per method plus boundary of one missing section; ordering of appended gate line
priority: high
risk: "the reader accepts a file missing a section, names the wrong section, or the manual gate leaves human: ok twice or not last, or appends it after a problem answer"
status: active
changed_by: 2026-11-06-ARK-312-1
---

## Objective

Prove the evidence reader accepts well-formed files for `demonstration`, `inspection` and `analysis`, rejects a file missing a section with the section named, and that `ark gate record <run> manual <AC id> ok` leaves `human: ok` once, as the last line.

## Preconditions

- Temp run folder. Files `results/evidence/<AC id>.md` written by the test. Well-formed shapes:
  - demonstration: sections `What the human did`, `What the human saw`, `Before` and `After` (each with a screenshot path line, shape only), final line exactly `human: ok`.
  - inspection: `Files` (lines `path:start-end`), `Checked against`, `Verdict`, line exactly `reviewer: pass`; a second file with `reviewer: fail` (also well-formed).
  - analysis: `Command`, `Output`, `Threshold`, `Result`, each with `Base` and `Head` subsections with content.
- Malformed matrix (one defect each, all else well-formed), expected reason in brackets:
  1. demonstration without `What the human saw` [`What the human saw`]
  2. demonstration with no screenshot path under `Before` [`Before`]
  3. demonstration with no screenshot path under `After` [`After`]
  4. demonstration whose `human: ok` is missing [`human: ok`]
  5. demonstration whose `human: ok` is not the last line (a line follows it) [`human: ok`]
  6. inspection without a reviewer line [`reviewer`]
  7. inspection with `reviewer: maybe` [`reviewer`]
  8. inspection `Files` entry without a line range (`src/a.ts`) [`Files`]
  9. analysis without Head under `Output` [`Output`]
  10. analysis without Base under each of `Command`, `Threshold`, `Result` (three variants) [section named]
- Screenshot paths are checked for shape, not existence.
- A run with the `manual` gate waiting for a demonstration AC, and one for an inspection AC and one for an analysis AC.

## Steps

1. Read each well-formed file with the evidence reader; assert accepted.
2. Read each malformed variant of the matrix; assert rejected and the reason contains the bracketed text. Separately assert a file holding all headings but one empty required value (variants 2, 3, 8) is rejected: sections present is not enough.
3. Create a demonstration file without the last line. Run `ark gate record <run> manual <AC id> ok`. Assert the last line is `human: ok` and it appears once.
4. Record `problem`, then `ok`, then `ok` again. Assert one `human: ok` line, last, and no other trailing content.
5. Record `problem` only on a fresh file. Assert no `human: ok` appended.
6. For the inspection AC and for the analysis AC record the manual gate `ok`. Assert each file is byte-identical to before.
7. Record `ok` with the evidence file absent. Assert the gate writes no file and no `human: ok` line (shippable check reports `evidence missing` later, see ARK-T7).

## Expected results

- When an evidence file lacks a section of its method, the system shall reject it and name the section.
- If a required value is empty or off-format (screenshot path under Before or After, line range in Files, reviewer marker other than `reviewer: pass` or `reviewer: fail`, Base or Head of an analysis section, final `human: ok` line of a demonstration), then the system shall reject the file and name the offending part.
- When an evidence file holds every section and every required value of its method, the system shall accept it.
- When `ark gate record <run> manual <AC id> ok` runs for a `demonstration` AC, the system shall leave exactly one `human: ok` line, as the last line of the file.
- If the answer is `problem`, then the system shall not append `human: ok`.
- Where the AC method is `inspection` or `analysis`, the system shall not change the evidence file on a manual `ok`.

## Screenshot checkpoints

none: integration case on markdown files; no UI surface.
