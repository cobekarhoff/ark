---
id: ARK-T752
title: ARK-T752 A full ark test replaces only the base and head folders of a case and keeps every other evidence file and folder
level: integration
technique: equivalence classes of the entries of results/evidence (top-level file, folder with no base/head, case folder with run-owned and worker-owned entries, a census folder a worker kept), state transition (full run, then a full run that replays the cache)
priority: high
risk: A full run deletes a worker's evidence beside base and head (cause.md, a CPU profile, an AC evidence folder, a census folder), as in ARK-480 and ARK-606; or it merges the old base/head into the new ones, so a stale result.json or log sits beside this run's results and the MR ships it
status: active
changed_by: 2026-11-20-ARK-614-1
---

## Objective

Prove that a full `ark test` owns only `<case>/base` and `<case>/head` under `results/evidence`: it replaces them whole with this run's results and keeps every other file and folder byte for byte. Serves ARK-614 AC1.

Expected: When a full `ark test` publishes its evidence, the system shall keep every top-level file, every folder with no `base` or `head`, and every other entry of a case folder (a `census` folder included) unchanged, and `<case>/base` and `<case>/head` shall hold only the files of this run.

## Preconditions

- The evidence fixture of `test/detached-runner.test.ts` (`evidenceFixture(false)`): a run with a workspace mirror and one suite whose test is tagged with one case id. The AC text calls that case `ARK-T1`; the fixture's id stands in for it.
- A full `ark test` of the run has finished with exit 0, so `results/evidence/ARK-T1/{base,head}/` exist.
- Then, written by hand into `results/evidence/`:
  - a top-level file `AC3.md`;
  - a folder `AC8/` with `notes.md` (no `base` or `head` in it);
  - in `ARK-T1/`: `cause.md`, `profile/p.cpuprofile` and `census/result.json` (a full run writes census evidence to `results/census/evidence.next`, never to `results/evidence`, so a `census` folder there is a worker's entry like any other);
  - stale run-owned files no run of this suite writes: `ARK-T1/head/old.log` and `ARK-T1/base/old.log`;
  - `ARK-T1/head/result.json` overwritten with a stale marker (`"sha": "stale"`).

## Steps

1. Record the tree of `results/evidence` with `treeOf` (path and content of every file).
2. Commit a change to the mirror so the next full run does not reuse the cached result. Run a full `ark test <run>` and wait for it to exit 0.
3. Record the tree again.
4. Run a full `ark test <run>` again with no change, so the suite result is replayed from the cache (a second way into the same publish), and wait for exit 0.
5. Record the tree again.

## Expected results

- After step 3 and after step 5, `AC3.md`, `AC8/notes.md`, `ARK-T1/cause.md`, `ARK-T1/profile/p.cpuprofile` and `ARK-T1/census/result.json` exist with the content of step 1.
- `ARK-T1/head` and `ARK-T1/base` hold exactly the files this run writes (`result.json`, `command.log`): no `old.log`. `ARK-T1/head/result.json` names the head commit of this run, not `stale`.
- Nothing next to `results/evidence` starts with `evidence` other than `evidence` itself (`evidenceEntriesOf`).
- At the base of this ticket the validator shows the test failing on `AC8/notes.md` and `ARK-T1/cause.md` missing after step 3 (the current `publishEvidence` keeps only top-level files).

## Screenshot checkpoints

none: the case compares files on disk; there is no screen.
