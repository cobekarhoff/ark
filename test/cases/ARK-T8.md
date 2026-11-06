---
id: ARK-T8
title: ARK-T8 merge-request open and handed_off refuse missing or stale test evidence
level: integration
technique: decision table (folder missing base / head, stale head SHA, valid, no verified_by)
priority: high
risk: a verified_by case ships without base or head evidence, a stale head SHA passes because it is compared to the wrong head function, or an old-scheme AC is wrongly refused
status: active
changed_by: 2026-11-06-ARK-312-1
---

## Objective

Prove both commands refuse a `method: test` AC whose `verified_by` case lacks a base or head evidence folder, or has a stale head SHA, and accept valid evidence and ACs without `verified_by`.

## Preconditions

- Fake run with a touched repo; AC1 `method: test`, `verified_by: [FAKE-T1]`; AC2 `method: test` with no `verified_by`. Everything else satisfied.
- Evidence written by the test under `results/evidence/FAKE-T1/{base,head}/result.json`. Valid head SHA = `headOf(repo, workspace, mirror)` (same function `staleHeads` uses), so the test works with mirror and composed workspace.
- Remote refs and `events.ndjson` line count recorded before each attempt.
- Cases: (1) no folder; (2) only `head/`; (3) only `base/`; (4) both, head SHA `deadbeef`; (5) both, head SHA current; (6) base SHA arbitrary (not checked against anything).

## Steps

1. Case (1): run `ark merge-request open`; assert message contains `test evidence missing: AC1 FAKE-T1 (base)` and `test evidence missing: AC1 FAKE-T1 (head)`.
2. Case (2): assert only the `(base)` line; case (3): only the `(head)` line.
3. Case (4): assert message contains `test evidence stale: AC1 FAKE-T1` and not `missing`.
4. Assert in each refusal that no push occurred and `events.ndjson` is unchanged.
5. Run `ark run close <run> handed_off` for cases (1) and (4); assert the same messages.
6. Case (5), (6): both commands pass the check; AC2 (no `verified_by`) produces no test evidence line in any case.
7. Make a commit in the repo after case (5) so head moves; assert `test evidence stale: AC1 FAKE-T1` on the next run.

## Expected results

- When a `verified_by` case has no `base/` or `head/` evidence folder, the system shall refuse with `test evidence missing: <AC id> <test case id> (<base|head>)`.
- When the SHA in the `head` `result.json` is not the head of the repo, the system shall refuse with `test evidence stale: <AC id> <test case id>`.
- Where an AC has no `verified_by`, the system shall not require test evidence.
- When the refusal fires, the system shall push nothing and append no event.

## Screenshot checkpoints

none: integration case on CLI refusals; no UI surface.
