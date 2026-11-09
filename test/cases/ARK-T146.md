---
id: ARK-T146
title: ARK-T146 the MR card of a closed run takes its state from the run outcome and the GitHub reader gets no closed-run URL
level: integration
technique: state transition / equivalence classes over outcome (merged, aborted, abandoned, handed_off) plus an open run as control
priority: high
risk: a closed run's MR card still shows `unknown`, aborted or abandoned shows merged, handed_off shows a card for an MR that does not exist, or the hub calls `gh pr view` for a closed run (cost and a stale state on every refresh)
status: active
changed_by: 2026-11-09-ARK-353-1
---

## Objective

Prove that the MR card state follows the outcome of a closed run, that handed_off has no card, and that `gh` is never asked about a closed run.

## Preconditions

- A hub started on a scratch `ARK_HOME` with real run folders (events, `state.json`, files), real snapshot and `runDetail()` code, and a real browser (Playwright, `test/pw/hub.pw.ts`). No mocks of the page or of the snapshot.
- Four closed runs, each with an MR URL in `state.json`: outcome merged, aborted, abandoned, handed_off.
- One open run with an MR URL (control).
- A fake `gh` first on `PATH` (or the injectable reader seam of `hub/sources.ts`) that logs every URL it is asked for and answers `open` for the control.

## Steps

1. Start the hub and let one snapshot refresh finish.
2. Open the page of each closed run and read its MR card.
3. Read the log of the fake `gh`.

## Expected results

- The merged run's MR card shall show `merged`.
- The aborted run's and the abandoned run's MR cards shall show `closed`.
- No closed run's MR card shall show `unknown`.
- The handed_off run's page shall show no MR card.
- The `gh` log shall hold the open run's URL and no URL of any closed run.

## Screenshot checkpoints

Four MR card states (merged, closed, closed, none), one shot each or one contact sheet.
