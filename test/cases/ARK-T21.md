---
id: ARK-T21
title: ARK-T21 run page shows non-test AC evidence in its shape or no evidence
level: e2e
technique: equivalence classes per method (demonstration, inspection, analysis); malformed and missing files as one class showing no evidence
priority: high
risk: "an evidence file is shown blank or as raw markdown, a wrong-shape file is shown as if valid, a missing file renders nothing, or no evidence is shown without the warning style"
status: active
changed_by: 2026-11-06-ARK-314-1
---

## Objective

Prove the run page shows the evidence file of each demonstration, inspection and analysis AC as text in the fixed shape of its method, and shows `no evidence` in the warning style for a missing file and for a file of the wrong shape.

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts`. Fixture run of ticket ARK-900 with ACs in `results/evidence/<AC id>.md`, shapes of ARK-312 (see ARK-T6):
  - AC1 `demonstration`: sections `What the human did` (`opened the run page`), `What the human saw` (`five rows`), `Before` and `After` (screenshot path lines, real PNGs in the evidence folder), last line `human: ok`.
  - AC2 `inspection`: `Files` with `hub/server.ts:120-150`, `Checked against` (`ADR 0009`), `Verdict`, line `reviewer: pass`.
  - AC3 `analysis`, sections `Command`, `Output`, `Threshold`, `Result`, each with a `Base` and a `Head` subsection holding these distinct values:
    - Command: Base `bun test --base`, Head `bun test --head`.
    - Output: Base `40 pass 2 fail`, Head `42 pass 0 fail`.
    - Threshold: Base `fail <= 0 (base)`, Head `fail <= 0 (head)`.
    - Result: Base `threshold missed`, Head `threshold met`.
  - AC4 `demonstration` with no evidence file.
  - AC5 `inspection` whose file lacks the `Verdict` section and the reviewer line (wrong shape).
- Text of each file contains a `<b>` and a `<script>` element string in one line to check escaping.

## Steps

1. Open the run page. `checkpoint(page, "evidence-files")`.
2. AC1: assert the text `opened the run page`, `five rows`, a before and an after image and the line `human: ok`.
3. AC2: assert `hub/server.ts:120-150`, `ADR 0009` and the verdict `reviewer: pass`.
4. AC3: within the `Command` section assert Base `bun test --base` and Head `bun test --head`; within `Output`, Base `40 pass 2 fail` and Head `42 pass 0 fail`; within `Threshold`, Base `fail <= 0 (base)` and Head `fail <= 0 (head)`; within `Result`, Base `threshold missed` and Head `threshold met`. Assert no Head value appears under Base or the reverse (no swap, no side missing).
5. AC4: assert the exact text `no evidence` in an element with the warning style (same warning class or `data-` marker used by the ticket page warning), not an empty element.
6. AC5: assert `no evidence` and not the partial text of its file.
7. Assert the `<b>` and `<script>` strings appear as visible text, no element is created from them and no dialog fired.
8. Assert no evidence block is blank: each of the five AC blocks has a non-empty text content.

## Expected results

- The system shall show the evidence file of each `demonstration`, `inspection` and `analysis` AC as text in the fixed shape of its method.
- A demonstration shall show what the human did and saw, its before and after screenshots and the line `human: ok`.
- An inspection shall show its files and line ranges, what was checked against what and the reviewer verdict.
- An analysis shall show the command, the output, the threshold and the result, each at base and at head, in its own section and side.
- If an evidence file is missing or has the wrong shape, then the system shall show `no evidence` in the warning style, never a blank.

## Screenshot checkpoints

- `evidence-files`: the five AC blocks, three in shape and two `no evidence`.
