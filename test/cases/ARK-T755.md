---
id: ARK-T755
title: ARK-T755 The pr-writing ledger lists as test case evidence only the folders of results/evidence that hold base, head or census
level: integration
technique: equivalence classes of the folders of results/evidence (case folder with base/head and extra files; orphan folder with only extra files; AC evidence folder; folder with only census), with the MR body as the observable
priority: high
risk: Now that a full ark test keeps worker folders, readEvidence turns AC8/ or an orphan case folder that kept only cause.md into a test case entry with base missing and head missing, so a run with no plan.yml gets a false "base missing, head missing" block in the MR body; or the filter drops a real case folder because it also holds cause.md
status: active
changed_by: 2026-11-20-ARK-614-1
---

## Objective

Prove that the ledger of `skills/pr-writing/lib` reads a folder of `results/evidence/` as a test case only when it holds `base`, `head` or `census`, so a folder a worker kept there never shows as a case in the MR body. Serves the reader of the evidence folder that ARK-614 AC1 and AC2 make see worker folders (`readEvidence`, evaluation risk "NOT safe").

Expected: When `results/evidence/` holds a folder with none of `base`, `head` and `census`, the system shall leave it out of the ledger's evidence entries and out of the MR body's case blocks.

## Preconditions

- A real run folder built with `makeRun` of `test/pr-writing.test.ts` (the builder ARK-T363 uses), with no `plan.yml`, so the body filters no entry by the plan (`ledger.planCases` is undefined).
- The ticket has a criterion `AC3` with no `verified_by` (as `suiteRun` sets up for ARK-T363), so the ledger reads `results/evidence/AC3.md` for it.
- `results/evidence/` holds:
  - `ARK-T1/` with `head/result.json` (passed, with a head sha), `base/result.json` (failed), `head/command.log`, and `cause.md` beside them;
  - `ARK-T9/` with only `cause.md` and `profile/p.cpuprofile` (an orphan case folder a full run stripped);
  - `AC8/` with only `notes.md`;
  - `ARK-T5/` with only `census/result.json`;
  - the AC evidence file `AC3.md`.
- The real ledger reader and `buildBody` from `skills/pr-writing/lib`. No mocks.

## Steps

1. Read the ledger of the run and list the `testCase` of each evidence entry.
2. Build the body with `buildBody` and read its `## Evidence` section.
3. Run lint check EVID03 on the body and the ledger.

## Expected results

- The evidence entries are `ARK-T1` and `ARK-T5`; there is none for `ARK-T9` or `AC8`.
- The `## Evidence` section has a block for `ARK-T1` with its base and head results and log tail, and the `AC3.md` block; it has no block, line or path for `ARK-T9`, `AC8`, `cause.md` or `p.cpuprofile`.
- EVID03 passes.
- At the base of this ticket the validator shows the test failing on an entry for `AC8` and `ARK-T9` (today every folder becomes an entry with `base missing, head missing`).

## Screenshot checkpoints

none: integration case on the ledger and the text of a built body; there is no screen.
