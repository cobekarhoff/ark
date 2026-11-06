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

- Fake run (existing fixtures of `test/merge-request*.test.ts`) with four non-test ACs: AC1 demonstration, AC2 inspection, AC3 analysis, AC4 demonstration; all gates otherwise satisfied (tests passed, heads fresh, manual proven) so only the evidence check can refuse.
- A fake git remote and an event log; the test records the remote's refs and the number of lines in `events.ndjson` before each attempt.
- Evidence states: (a) none; (b) AC1 missing, AC2 malformed (no Verdict), AC3 malformed (no Result Head), AC4 well-formed; (c) all four well-formed.
- Old-scheme `manual: true` AC with no evidence file present as a fifth AC in state (a).
- Existing fixtures with manual ACs get evidence written in setup.

## Steps

1. State (a): run `ark merge-request open`; capture error text.
2. Assert it contains `evidence missing: AC1 (demonstration)`, `evidence missing: AC2 (inspection)`, `evidence missing: AC3 (analysis)`, and the same for the old `manual: true` AC as `demonstration`; all in one message.
3. Assert remote refs and event count are unchanged.
4. State (b): run `ark run close <run> handed_off`; assert message holds `evidence missing: AC1 (demonstration)`, `evidence malformed: AC2: <reason naming Verdict>`, `evidence malformed: AC3: <reason naming Result>`, and no line for AC4.
5. Assert no event appended and the run status unchanged.
6. Run the same two commands in state (b) with an unproven manual criterion; assert the existing manual-gate error still appears first and unchanged (evidence check follows it).
7. State (c): run both commands; assert the evidence check passes (command proceeds to push/event, or the shippable function returns).

## Expected results

- When a non-test AC has no evidence file, the system shall refuse with `evidence missing: <AC id> (<method>)` before any push and before any event.
- When a non-test AC has a malformed evidence file, the system shall refuse with `evidence malformed: <AC id>: <reason>` before any push and before any event.
- The refusal shall name every AC with missing or malformed evidence in one message.
- When every non-test AC has a well-formed evidence file, the system shall pass the evidence check on both commands.

## Screenshot checkpoints

none: integration case on CLI refusals; no UI surface.
