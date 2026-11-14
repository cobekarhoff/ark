---
id: ARK-T373
title: ARK-T373 merge-request open accepts a head that moved past the passing test only by clean ark worktree sync merges, and names the tested and the merged commit
level: integration
technique: state transition (tested, target moves, synced, opened) with a repeated sync as a sequence case
priority: high
risk: a main move between the passing test and the open still refuses the finished run, either because staleHeads reads the merge commit as a changed head, or because the evidence check refuses the `verified_by` case as `test evidence stale` (its evidence sha H is compared with the merge commit); or open proceeds without naming what was not tested
status: active
changed_by: 2026-11-13-ARK-463-1
---

## Objective

Prove that after a passing full `ark test` at head H, a target move and a conflict-free `ark worktree sync`, `ark merge-request open` is not refused, `ark status` calls the test head current, and open prints one line that names H and the merged target commit. The AC under test has a `verified_by` case, so the evidence check runs against `results/evidence/<case>/head/result.json` (sha H) and the case fails for each of the two refusal paths (`staleHeads` and the test evidence check) and for a missing line. The own-commit refusal is owned by ARK-T374 (a), not repeated here.

## Preconditions

- Fixture of `test/sync-base.test.ts` (`syncedRun`) with one change: `FAKE-1-AC1` has `method: test` and `verified_by: [FAKE-T1]` (`writeTicket` takes `verified_by`), the plan names the case `FAKE-T1` for that AC, and the fixture suite holds a test titled `FAKE-T1 ...` that passes. After the passing `ark test`, `results/evidence/FAKE-T1/head/result.json` exists and holds sha H. The test asserts that file exists and that its `sha` equals H before it opens, so the evidence check cannot be skipped for want of a `verified_by` list. Without this change the AC is proven only by the plan case and `evidenceProblems` never runs.
- The origin is a local bare repo on `main`, the run is at the building phase with one own commit made before the test. Target moves with the `moveTarget` helper of that file (a commit that touches a file the run never touched, so the sync merges without conflict). The host is the fake host of `test/fixtures/merge-request` (`gh` and `fake-host.ts`), as ARK-T307 in `test/sync-base.test.ts` uses it: that directory is first on `PATH` and `FAKE_LOG` points at a temp `calls.ndjson`. Its `gh pr list` probe answers a JSON array, so `postMergeRequest` opens the MR and `ark merge-request open` exits 0 after it pushes to the bare origin. The one-object `gh` stub of `test/sync.test.ts` is not used: its probe answer is not an array, so open throws `ProbeFailure` after the push and exits non-zero whatever `staleHeads` does.
- The run's `ark test` is a full test (not `--quick`) and passes. The test reads H with `git -C <worktree> rev-parse HEAD` after it and keeps it. The target commit T1 is the value `moveTarget` returns; the test never takes either sha from `staleHeads`, `headOf`, `evidenceProblems` or any other code under test.
- `merge_requests` mode of the project is the default, so `mergeRequestOpen` runs; every other open condition (plan approved, manual criteria) is satisfied by the run that passed the test.
- The test records the `git ls-remote origin` refs and the `events.ndjson` line count before each open.
- This case is also the accepted control for ARK-T374: every refusal there is a variant of this one clean sync.

## Steps

1. Run `ark test <run>`; assert exit 0. Record H. Assert `results/evidence/FAKE-T1/head/result.json` holds sha H.
2. `moveTarget` with a new file; record T1. Run `ark worktree sync <run>`; assert exit 0 and that the worktree head is a merge commit whose first parent is H and whose second parent is T1 (`git rev-parse HEAD^1`, `HEAD^2`).
3. Run `ark status <run>`; assert its `test head:` line says `current` and not `stale`.
4. Run `ark merge-request open <run>`; assert exit 0 and a branch `ark/...` pushed to the origin whose tip is the merge commit.
5. Assert the output holds exactly one line that contains the first 8 hex characters of H and the first 8 of T1, and that its error text has neither `changed since the last test run` nor `test evidence stale`.
6. Sequence variant: in a fresh fixture of the same shape (with `verified_by`), run the test, move the target and sync, move the target again and sync again (H -> M1 -> M2, both clean), then open. Assert exit 0 and that the one line names H and the newest merged target commit T2.
7. Run the same open in the step 2 fixture a second time (the MR is open, the head unchanged). Assert that the open still exits 0 and refuses nothing as stale.

## Expected results

- When the last passing full test recorded head H and the head is now a merge commit whose first parent is H and whose second parent is a commit of `origin/<target>` made by `ark worktree sync` with no conflict, the system shall not refuse `ark merge-request open` as `changed since the last test run`, and shall not refuse the `method: test` AC whose `verified_by` case has evidence sha H as `test evidence stale`.
- When it accepts such a head, `ark merge-request open` shall print one line that names H and the merged target commit, and shall push the merged head.
- When it accepts a chain of several clean syncs, the line shall name H and the newest merged target commit.
- `ark status` shall print `test head: current` for such a head.

## Screenshot checkpoints

none: integration case on CLI output and git state; no UI surface.
