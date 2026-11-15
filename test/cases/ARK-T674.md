---
id: ARK-T674
title: ARK-T674 finishing an implementer step that started with --merge skips the plan membership check, so main's test changes are not refused
level: integration
technique: state transition (step start with and without --merge) over the same diff
priority: high
risk: "a --merge implementer step diffs HEAD against the old base, which holds main's test changes, and is refused for case ids the run never touched, so a sync conflict can never be resolved; or the skip leaks and an ordinary step with the same diff is also not checked"
status: active
changed_by: 2026-11-14-ARK-496-1
---

## Objective

Prove that a `--merge` implementer finish is not refused for case ids that the merged target branch brought in. Serves ARK-496/AC1. The worktree.synced base moves only after the finish (`recordMergedTarget`), so at finish time the diff from the old base still holds main's tests.

Expected: When an implementer step started with `--merge` finishes, the system shall skip the plan membership check silently (no `plan-membership` line, no refusal); a step started without `--merge` over the same diff shall still be refused.

## Preconditions

- The fixture of ARK-T671 plus an origin repo and the setup of ARK-T305 repo B: the run's worktree has base `C0` and one own commit that edits line 1 of `notes.txt` (a file outside the test files); origin's target branch has a commit `C1` that edits the same line of `notes.txt` (so a sync conflicts) and edits the `ARK-T9` test (a case id the plan does not list).
- `plan.yml` with an implementer step and `test_cases` listing only `ARK-T1`.
- Second run for step 2: the same fixture, but its own commit edits no line of `notes.txt`, so the merge is clean and no sync has failed.

## Steps

1. Run `ark worktree sync <run>`; it conflicts and the repo is in `sync_conflicts` (the `--merge` start needs that). Start the step with `ark run step <run> <step> start --merge`. Merge `origin/<target>` in the worktree by hand, resolve `notes.txt` and commit (the merge brings `ARK-T9`). Run `finish`; read exit code, output and the `worktree.synced` events.
2. In the second run, start the step without `--merge` (no sync conflict, so a `--merge` start would be refused), merge the same commit by hand, run `finish`.

## Expected results

- Step 1: exit 0, no `case id not in plan test_cases` line, no `plan-membership` line at all (the skip prints nothing), one `step.finished` event, and a `worktree.synced` event whose `target_commit` is `C1` (ARK-T305 unchanged). The `start --merge` itself exited 0.
- Step 2: exit 1, the output names `ARK-T9`. The skip is bound to the `--merge` start, not to the diff.

## Screenshot checkpoints

none: CLI output, exit code and the event log; no UI.
