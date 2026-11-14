---
id: ARK-T8
title: ARK-T8 merge-request open and handed_off refuse missing or stale test evidence
level: integration
technique: decision table (folder missing base / head, stale head SHA, valid, no verified_by)
priority: high
risk: a verified_by case ships without base or head evidence, a stale head SHA passes because it is compared to the wrong head function, or an old-scheme AC is wrongly refused
status: active
changed_by: 2026-11-13-ARK-463-1
---

## Objective

Prove both commands refuse a `method: test` AC whose `verified_by` case lacks a base or head evidence folder, or has a stale head SHA, and accept valid evidence and ACs without `verified_by`.

## Preconditions

- Fake run with a touched repo; AC1 `method: test`, `verified_by: [FAKE-T1, FAKE-T2]`; AC2 `method: test` with no `verified_by`. Everything else satisfied. A fresh fixture (run folder, fake remote, event log) is built for each case and command pair below.
- Evidence written by the test under `results/evidence/<case>/{base,head}/result.json`. The valid head SHA is `git -C <repo checkout the run composes> rev-parse HEAD` run by the test in the fixture, not `headOf` or `staleHeads`. When the fixture uses a mirror and composed workspace, the test also makes the mirror head differ from the workspace head and expects the workspace SHA.
- The test records remote refs (`git ls-remote`), `events.ndjson` line count and run status before each attempt.
- FAKE-T2 is always fully valid, so a check that stops at the first list entry fails. Cases for FAKE-T1 (with FAKE-T2 valid): (1) no folder; (2) only `head/`; (3) only `base/`; (4) both, head SHA `deadbeef`; (5) both, head SHA current; (6) both, head SHA current, base SHA arbitrary. Variant (7): FAKE-T1 valid and only FAKE-T2 invalid (no folder), listed second.

## Steps

1. For each of cases (1) to (4) and (7), run `ark merge-request open` and, in a fresh fixture, `ark run close <run> handed_off`. Capture the error text and exit code.
2. Case (1): assert both `test evidence missing: AC1 FAKE-T1 (base)` and `test evidence missing: AC1 FAKE-T1 (head)`, and no line for FAKE-T2. Case (2): only the `(base)` line. Case (3): only the `(head)` line. Case (4): `test evidence stale: AC1 FAKE-T1` and no `missing`.
3. Case (7): assert `test evidence missing: AC1 FAKE-T2 (base)` and `(head)` lines, none for FAKE-T1.
4. For every refusal assert remote refs, `events.ndjson` line count and run status are unchanged.
5. Cases (5) and (6), both commands: assert no test-evidence refusal text and the commands proceed (push, or event appended). AC2 (no `verified_by`) never produces a test evidence line in any case.
6. Wrong repo: the run has a second repo with a different head. Write FAKE-T1's head `result.json` with `repo` of the first repo and the SHA that is the second repo's head; FAKE-T2 valid. Assert both commands refuse with `test evidence stale: AC1 FAKE-T1` only.
7. Unusable head evidence: write FAKE-T1's head `result.json` without a `sha`, once with an unknown `repo`, once with a known `repo`, once with no `repo` (an old file). Assert both commands refuse with `test evidence stale: AC1 FAKE-T1` only.
8. In a fresh case (5) fixture, make a new commit in the repo so head moves (record the new `rev-parse HEAD`); assert both commands refuse with `test evidence stale: AC1 FAKE-T1` and `... FAKE-T2` and nothing pushed.

## Expected results

- When a `verified_by` case has no `base/` or `head/` evidence folder, the system shall refuse with `test evidence missing: <AC id> <test case id> (<base|head>)` on both commands, naming the exact missing folder only.
- When the SHA in the `head` `result.json` is not the git head of the repo that ran the case (the `repo` in that `result.json`), and the git head was not reached from that SHA only by clean `ark worktree sync` merges of the target (ARK-T373 owns that accepted shape), also when the `sha` is not a string or the `repo` is missing or unknown, also when it is the current head of another repo of the run, the system shall refuse with `test evidence stale: <AC id> <test case id>` on both commands.
- The system shall check every case in `verified_by`, not only the first.
- Where an AC has no `verified_by`, the system shall not require test evidence.
- When the refusal fires, the system shall push nothing and append no event.

## Screenshot checkpoints

none: integration case on CLI refusals; no UI surface.
