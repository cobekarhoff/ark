---
id: ARK-T142
title: ARK-T142 the post-merge refresh moves a submodule to the merged commit
level: integration
technique: "state transition, plus a load condition: an opt-in fixture delay that pushes the three tests built on submoduleRun() past the 30 s default test limit"
priority: high
risk: "the submodule moves to the branch head of a squash-merged upstream, or the refresh commit never reaches the remote, so the downstream MR pins a commit that is not on the upstream target branch; a test dies on the 30 s default limit when its ark processes and git clones run on a loaded host, so a good refresh reads as a failure and a real regression hides in the noise (ARK-599: the squash test timed out at 30018 ms in the full test of run 2026-11-19-ARK-512-1)"
status: active
changed_by: 2026-11-20-ARK-599-1
---

## Objective

Prove that the post-merge refresh moves a submodule to the merged commit.

## Preconditions

Repo lib and repo app (holds lib as the submodule libs/lib) each have a bare remote. The lib MR !41 is merged by squash: the commit on main differs from the branch head. The app MR !87 waits for !41, and its bump step bump-lib points libs/lib at the lib branch head. The reviewer findings file `findings/review.md` holds `Not in plan:` lines for the unplanned files (`app/libs/lib`, `lib/feature.txt`), so the reviewer finish is not refused.

Opt-in fixture delay: the three tests built on `submoduleRun()` (the squash test "after the upstream MR squash merges, the refresh moves the submodule to the merged commit and the push carries it", the fast-forward test "refreshing a fast-forward merge records the event and makes no commit" and the refresh commit test "the refresh commit holds only the gitlink, and unrelated staged work stays staged", all in `test/post-mr.test.ts`) take an opt-in delay: a `reference-transaction` hook that every git ref update waits on, set through `GIT_CONFIG_*`. The delay runs only when the environment variable `ARK_T142_REF_DELAY=1` is set, read in the test file. Without it the three tests run with no hook and no sleep, so a normal run, CI and `ark test` pay no delay, and no other caller of `submoduleRun()`, `ark()`, `spawnArk` or `fakeHosts` changes. The hook is appended after the entries that `test/tmpdir-preload.ts` sets (`maintenance.auto`, `gc.auto`, `init.defaultBranch`), and it is removed after the test, so every other test of the file sees the same environment as before. The delay is a fixture input, not a product setting, and it is never written with `setTimeout(`, `Bun.sleep(` or a three-digit `toBeLessThan`, so `test/wallclock.test.ts` stays green. It is sized so that each of the three, with the 30 s default and the variable set, runs past 30 s, and so that the new limit still holds. The delay covers the setup of `submoduleRun()` (7 ark processes and about 16 git processes) as well as the body, because both spend time on a loaded host. Why each test is in the delay proof:

- The squash test (16.2 s on a quiet host, 30018 ms under load in run 2026-11-19-ARK-512-1): the test that timed out. Required.
- The fast-forward test (5.8 s): shares the `submoduleRun()` setup of 7 ark processes and about 16 git processes with the squash test, so a slow host slows its setup the same way.
- The refresh commit test (4.0 s): same `submoduleRun()` setup as the squash test.

The test "bump refresh refuses a step that is not a bump step and records nothing" (0.9 s) builds its run with `openRun()` and runs one `ark bump refresh` that throws before any git or host call. It has no clone and no host call for a delay to model, so it gets a limit and no delay proof.

All four tests carry their own limit, a literal `{ timeout: 120_000 }` option, never the 30 s default of `setDefaultTimeout(30_000)`. The titles and the case id of each test do not change.

## Steps

Run the case with `bun test test/post-mr.test.ts`; the quick repeat is `bun test --rerun-each=N test/post-mr.test.ts`.

1. Make the host fail and run `ark bump refresh <run> bump-lib`.
2. Make the host answer and run `ark merge-request status <run>`.
3. Run `ark bump refresh <run> bump-lib`, then `ark merge-request status <run>`.
4. Finish the validator and reviewer steps, run `ark test <run>`, then `ark worktree sync <run>`.
5. Merge the upstream MR by fast-forward (the merged commit is the pinned branch head) and run `ark bump refresh <run> bump-lib`.
6. Squash-merge the upstream MR, stage an unrelated file in the app worktree and run the refresh.
7. Run `ark bump refresh <run> implementer --to 1.0.0` on a run whose plan has no such bump step.
8. Red run: at the validator commit (`ARK_T142_REF_DELAY=1` set, the old assertions, the 30 s default, before the implementer adds the limits), run `ARK_T142_REF_DELAY=1 bun test test/post-mr.test.ts` and read the result of each of the three delayed tests. This is not the base: base has no delay input and passes.
9. Green run: at head (`ARK_T142_REF_DELAY=1` set, `{ timeout: 120_000 }` on all four tests), run `ARK_T142_REF_DELAY=1 bun test test/post-mr.test.ts` and read the result of each of the four.
10. Delay-off run: run `bun test test/post-mr.test.ts` with `ARK_T142_REF_DELAY` unset (the default) and read the result of each of the four.
11. Repeat: run `bun test --rerun-each=N test/post-mr.test.ts` (N = 5) at head with `ARK_T142_REF_DELAY` unset and read that every repeat of the four tests passes.

## Expected results

- The refresh with the failing host exits non-zero and leaves libs/lib at the branch head.
- The first status shows `waits for !41 (merged)` and `points at upstream branch ` with the branch head.
- The refresh prints `refreshed bump-lib to <8 characters of the merged commit>`, libs/lib in the app worktree is at the merged commit, and the status shows `refreshed to <8 characters>`.
- `ark test` exits 0, and the app branch on the bare remote equals the worktree head and holds the merged commit at libs/lib.
- The fast-forward refresh exits 0, makes no new commit, leaves the app head unchanged and records one `bump.refreshed` with the pinned commit.
- The refresh commit holds only `libs/lib`, and the unrelated file is still staged.
- The refresh of a step that is not a bump step exits 1 with `is not a bump step of the plan` and records no `bump.refreshed`.
- Step 8: at the validator commit the squash, fast-forward and refresh commit tests each fail with a timeout at the 30 s default; the not-a-bump-step test passes (the whole file runs, with no delay) and is not part of the red proof.
- Step 9: at head all four tests pass with every assertion above unchanged.
- Step 10: with the variable unset, all four tests pass with every assertion above unchanged and with no sleep; every other caller of the shared helpers (the rest of `test/post-mr.test.ts` and the files that call `fakeHosts`, `ark()` and `spawnArk`) runs as before, which the full `cli` suite shows.
- Step 11: every repeat of the four tests passes.

Proof: `test/post-mr.test.ts`.

## Screenshot checkpoints

None. The surface is CLI output.
