---
id: ARK-T6
title: ARK-T6 evidence file shape of each method is checked
level: integration
technique: equivalence classes per method plus boundary of one missing section; ordering of appended gate line
priority: high
risk: the reader accepts a file missing a section, names the wrong section, or the manual gate leaves human: ok twice or not last, or appends it after a problem answer
status: active
changed_by: 2026-11-06-ARK-312-1
---

## Objective

Prove the evidence reader accepts well-formed files for `demonstration`, `inspection` and `analysis`, rejects a file missing a section with the section named, and that `ark gate record <run> manual <AC id> ok` leaves `human: ok` once, as the last line.

## Preconditions

- Temp run folder. Files `results/evidence/<AC id>.md` written by the test:
  - demonstration: sections `What the human did`, `What the human saw`, `Before`, `After` (each with a screenshot path line), last line `human: ok`.
  - inspection: `Files` (path:line-range), `Checked against`, `Verdict`, line `reviewer: pass`; a second file with `reviewer: fail` (accepted as well-formed).
  - analysis: `Command`, `Output`, `Threshold`, `Result`, each with Base and Head subsections.
- Malformed variants: demonstration without `What the human saw`; inspection without a reviewer line; analysis without Head under `Output`; demonstration with no screenshot path under `Before`.
- Screenshot paths are checked for shape, not existence.
- A demonstration AC in a run with `manual` gate waiting.

## Steps

1. Read each well-formed file with the evidence reader; assert accepted.
2. Read each malformed variant; assert rejected, and the reason names the missing section (e.g. `What the human saw`).
3. Create a demonstration file without the last line. Run `ark gate record <run> manual <AC id> ok`. Assert the file's last line is `human: ok` and it appears once.
4. Record `problem`, then `ok`, then `ok` again. Assert one `human: ok` line, last, and no other trailing content.
5. Record `problem` only on a fresh file. Assert no `human: ok` appended.
6. For an inspection AC, record the manual gate `ok`. Assert the file is not modified (the line is for demonstration only).
7. Record `ok` with the evidence file absent. Assert the gate writes no file and creates no `human: ok` line (the shippable check reports `evidence missing` later, see ARK-T7).

## Expected results

- When an evidence file lacks a section of its method, the system shall reject it and name the section.
- When an evidence file holds every section of its method, the system shall accept it.
- When `ark gate record <run> manual <AC id> ok` runs for a `demonstration` AC, the system shall leave exactly one `human: ok` line, as the last line of the file.
- If the answer is `problem`, then the system shall not append `human: ok`.
- Where the AC method is `inspection` or `analysis`, the system shall not change the evidence file on a manual `ok`.

## Screenshot checkpoints

none: integration case on markdown files; no UI surface.
