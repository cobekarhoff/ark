---
id: ARK-T19
title: ARK-T19 run page shows a test evidence panel row for each plan case
level: e2e
technique: equivalence classes of plan action (add, update, reuse, retire) times level (unit, integration, e2e) times result (pass, fail, not run); boundary of one run with no evidence folder
priority: high
risk: "a plan action is dropped from the panel, base and head results are swapped or shown as color only, a not-run side shows pass, a CLI case hides its command, output or exit code, or a row has no link to its ACs"
status: active
changed_by: 2026-11-06-ARK-314-1
---

## Objective

Prove the run page test evidence panel holds one row for each case the plan marks `add`, `update`, `reuse` or `retire`, with action, level, base and head result, both SHAs, the command log of CLI and integration cases and a link to the ACs.

## Preconditions

- Playwright spec in `test/pw/hub.pw.ts` on a fixture run of ticket ARK-900 in `merge_requests_open`, plan `test_cases`:
  - `ARK-T1` add, integration: base `fail`, head `pass`; base sha `9b85039`, head sha `1a2b3c4`; `command.log` base holds command `bun test test/a.test.ts`, output `1 fail`, exit 1; head holds the same command, output `1 pass`, exit 0.
  - `ARK-T2` update, e2e: base `pass`, head `pass`.
  - `ARK-T3` reuse, unit: base `pass`, head `pass`.
  - `ARK-T4` retire, integration: no evidence folder for either side (both `not run`).
  - `ARK-T5` add, e2e: base folder missing, head `fail` (boundary: one side not run).
- Evidence under `results/evidence/<id>/{base,head}/{result.json,command.log}` of the fixture run folder. `verified_by` ties T1 to ARK-900 AC1 and AC2, T2 to AC2.
- A second run of the same ticket with no `results/evidence` folder at all.

## Steps

1. Open the run page `#/run/<run>`. `checkpoint(page, "evidence-panel")`.
2. Assert the panel has exactly five rows, one per plan case, in plan order.
3. Assert row T1 shows `add`, `integration`, base text `fail`, head text `pass`, SHAs `9b85039` and `1a2b3c4`.
4. Assert row T1 shows for base the command `bun test test/a.test.ts`, output `1 fail` and exit code `1`, and for head the output `1 pass` and exit code `0`.
5. Assert rows T2, T3, T4 show actions `update`, `reuse`, `retire` with levels `e2e`, `unit`, `integration`; T4 reads `not run` on both sides; T5 reads `not run` base and `fail` head.
6. Assert each row has a link to the ACs it verifies: T1 links `AC1` and `AC2`, `href` ending `#/ticket/ARK-900`; a case that verifies no AC shows no empty link.
7. Open the run with no evidence folder. Assert the rows still show every plan case with `not run` on both sides, the panel does not crash and no row shows `pass`.

## Expected results

- When the run page opens, the system shall show one evidence row for each test case that the plan marks `add`, `update`, `reuse` or `retire`.
- Each row shall show the case id, the plan action, the level, the base result (`pass`, `fail` or `not run`), the head result and both commit SHAs, as text.
- A row of a CLI or integration case shall show the command, the output and the exit code of each run.
- Each row shall link to the ACs it verifies.

## Screenshot checkpoints

- `evidence-panel`: the panel with five rows, T1 expanded to show its command log.
