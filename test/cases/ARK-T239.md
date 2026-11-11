---
id: ARK-T239
title: ARK-T239 ark merge-request open refuses a repo whose head conflicts with origin's target after a fetch, changes no file or ref, and passes the same branch once a merge commit repairs it
level: integration
technique: equivalence classes (conflicting, repaired, merge-tree error) with a no-side-effect check
priority: high
risk: open pushes a branch that conflicts with the target, so the PR cannot merge (ARK-299); or the check merges in the worktree or leaves a ref, index or file changed; or after a merge step repairs the branch, open still refuses because it reads state instead of git; or a merge-tree error such as a missing target counts as a pass; or the message does not name the repo and the --merge step
status: active
changed_by: 2026-11-11-ARK-407-1
---

## Objective

Prove that `ark merge-request open` checks a real merge of the head into `origin/<target>` after a fetch, refuses an unrepaired conflict with the repo name and the `--merge` remedy, changes nothing, and accepts the same branch after its merge commit, with no new sync.

## Preconditions

- Real git (2.38 or later for `merge-tree --write-tree`), a temp bare `origin`, a run worktree on the run branch in run state ready for open, with fake `gh` on PATH as the existing open tests use.
- Origin's target and the run branch both change the same line of one file after their common commit, and the fetch brings the target change that the worktree lacks. No sync has run.
- A second repo in the run that merges cleanly.
- An error fixture: a separate ready-to-open run worktree whose branch has no common ancestor with `origin/<target>` (unrelated histories), so `git merge-tree --write-tree` fails with an error that is not a conflict.

## Steps

1. Record `git rev-parse HEAD`, `git status --porcelain` and `git for-each-ref` of the conflicting worktree.
2. Run `ark merge-request open <run>`. Read the exit code, the output, the origin refs and the fake `gh` log.
3. Repeat step 1 and compare.
4. In the worktree run `git merge origin/<target>`, resolve the conflict and commit (the merge step). Do not run `ark worktree sync`.
5. Run `ark merge-request open <run>` again. Read the exit code, the fake `gh` log and the origin refs.
6. In the error fixture, run `ark merge-request open <run>`. Read the exit code, the output, the origin refs and the fake `gh` log.

## Expected results

- When the head does not merge cleanly into the target, the system shall exit non-zero, and the message shall name the repo and say to start an implementer step with `--merge`.
- The system shall push nothing and post no MR, for any repo of the run, including the clean one.
- After step 2 the head, the `git status` output and every local ref except the fetched `origin/*` shall equal their step 1 values (the check changed no file and no ref).
- After the merge commit (step 4), `ark merge-request open` shall pass the check and push with no new sync.
- When the merge check itself errors (step 6, unrelated histories), the system shall exit non-zero, show git's error text, and push nothing: an error is a refusal, not a pass.

## Screenshot checkpoints

none: CLI integration case; the observables are exit codes, git refs and the fake `gh` log.
