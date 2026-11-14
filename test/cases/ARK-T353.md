---
id: ARK-T353
title: "ARK-T353 a P0 or P1 finding with no Repro: line stops the auto answer under the cap, adding the Repro: line restores it, and a dropped line for the finding restores it too"
level: integration
technique: "decision table (finding rank x Repro line present) and error guessing (P2 without Repro, No findings)"
priority: high
risk: "Ark reads an older reviewer findings file instead of the newest by mtime, Ark auto-answers when the human's judgment matters, the check reads the whole file instead of each finding block so another finding's Repro hides the gap, a legal P2 or `No findings.` file wrongly blocks the auto answer, a dropped P1 with no Repro still forces a human ask, or a dropped line for one finding (or a dropped line outside `## Run lead decision`) hides a different P1 with no Repro"
status: active
changed_by: "2026-11-14-ARK-391-1"
---

## Objective

Prove that the latest reviewer findings file is checked at start time, and that a P0 or P1 finding block with no `Repro:` line makes Ark leave the escalation to the human even under the cap.

## Preconditions

- A scratch ARK_HOME and a fake `orca` on PATH; no real Orca, omp or test-runner.
- `gates.escalation: auto`, `escalation_rounds: 4`, a building run whose round budget is spent (0 extra rounds used).
- A reviewer step with a findings file `findings/<reviewer step>.md` in the run folder. Other files in `findings/` (`round-<n>.md`, `test-case-review-<n>.md`) follow the same naming the product uses for reviewer files.

## Steps

1. Write a findings file with `### P1: title` and no `- **Repro:**` line. Start an extra round.
2. Write the file with two findings: a P1 with a Repro line, then a P0 with none. Start an extra round.
3. Add the `- **Repro:**` line to the finding that lacks it (every P0 and P1 has one). Start an extra round.
4. Write a file with `### P2: title` and no Repro line. Start an extra round (new run or fresh budget as needed).
5. Write a file that holds only `No findings.`. Start an extra round.
6. Write two reviewer findings files for two reviewer steps: an older one (set its mtime earlier, for example with `touch -t`) holding a P1 with no Repro line, and a newer one (later mtime) holding only `No findings.` or P0/P1 blocks that all have Repro lines. Start an extra round. Then swap the mtimes so the file with the missing Repro is the newest, and start an extra round.
7. Write a file with `### P1: slow export` with no Repro line and a `## Run lead decision` section holding `- dropped slow export: no Input`. Start an extra round. Then write a file with two P1 blocks without Repro, `### P1: slow export` and `### P1: leaks handle`, and the same one dropped line (only `slow export`). Start an extra round. Then write a file with `### P1: slow export` with no Repro line and the line `- dropped slow export: no Input` in a `## Notes` section, not in `## Run lead decision`. Start an extra round.

## Expected results

- Steps 1-2: the start is refused with the escalation refusal; no `gate.answered` is added; the gate waits for the human.
- Step 3: Ark records `gate.answered` (one_more_round, by auto) and the output says `(1 of 4)`.
- Steps 4-5: Ark answers by auto as in step 3.
- Step 6: with the clean file newest, Ark answers by auto (the older file is ignored). After the swap, the start is refused as in step 1. The newest file by mtime wins, not file name order and not the file with the most findings.
- Step 7: with the one P1 dropped, Ark answers by auto as in step 3 (a dropped P1 with no Repro no longer holds the answer). With `leaks handle` still lacking a Repro and not dropped, the start is refused as in step 1. With the dropped line outside `## Run lead decision`, the start is refused as in step 1.

## Screenshot checkpoints

None. The surface is CLI output, config load errors and run events; no screenshot applies.
