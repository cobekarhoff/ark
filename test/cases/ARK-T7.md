---
id: ARK-T7
title: ARK-T7 merge-request open and handed_off refuse missing or malformed evidence
level: integration
technique: decision table (missing / malformed / valid) times two entry points; ordering check
priority: high
risk: a missing or malformed file ships; only the first bad AC is named; the refusal happens after a push or an event; ark run close handed_off does not share the check
status: active
changed_by: 2026-11-06-ARK-312-1
---

## Objective

Prove `ark merge-request open` and `ark run close <run> handed_off` refuse, before any push and any event, a non-test AC with a missing or malformed evidence file, name every such AC, and pass with well-formed files.

## Preconditions

- Fake run (existing fixtures of `test/merge-request*.test.ts`) with four non-test ACs: AC1 demonstration, AC2 inspection, AC3 analysis, AC4 demonstration; all other gates satisfied (tests passed, heads fresh, manual proven) so only the evidence check can refuse. A fresh fixture (new run folder, new fake remote, new event log) is built for every state-and-command pair below.
- Before each attempt the test records the remote's refs (`git ls-remote`), the line count of `events.ndjson` and the run status from `state.json`.
- Evidence states:
  - (a) no evidence files; plus a legacy `manual: true` AC5 with no evidence file (treated as `demonstration`).
  - (b) AC1 missing, AC2 malformed (no Verdict), AC3 malformed (no Result Head), AC4 well-formed. No legacy AC; manual gate satisfied.
  - (c) all four well-formed.
- Existing fixtures with manual ACs get evidence written in setup.

## Steps

1. For each of state (a) and state (b), and for each command in `ark merge-request open` and `ark run close <run> handed_off` (four fresh fixtures): run the command and capture the full error text and exit code.
2. State (a), either command: assert exit non-zero and the one message holds `evidence missing: AC1 (demonstration)`, `evidence missing: AC2 (inspection)`, `evidence missing: AC3 (analysis)`, `evidence missing: AC4 (demonstration)`, `evidence missing: AC5 (demonstration)`.
3. State (b), either command: assert exit non-zero and the one message holds `evidence missing: AC1 (demonstration)`, `evidence malformed: AC2: <reason naming Verdict>`, `evidence malformed: AC3: <reason naming Result>` and no `AC4` line.
4. After each refusal assert remote refs equal the recorded refs, `events.ndjson` line count is unchanged, and `state.json` status is unchanged.
5. In a fresh state-(b) fixture of each command with an unproven manual criterion, assert the existing manual-gate error appears and is unchanged from before this feature (evidence check does not replace it).
6. State (c), fresh fixture for each command: assert no `evidence` refusal text. For `merge-request open` assert the remote ref was pushed; for `handed_off` assert the event was appended and the status changed.

## Expected results

- When a non-test AC has no evidence file, the system shall refuse with `evidence missing: <AC id> (<method>)` before any push and before any event, on both commands.
- When a non-test AC has a malformed evidence file, the system shall refuse with `evidence malformed: <AC id>: <reason>` before any push and before any event, on both commands.
- The refusal shall name every AC with missing or malformed evidence in one message, including a legacy `manual: true` AC.
- When every non-test AC has a well-formed evidence file, the system shall pass the evidence check on both commands.

## Screenshot checkpoints

none: integration case on CLI refusals; no UI surface.
