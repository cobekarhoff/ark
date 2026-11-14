---
id: ARK-T385
title: ARK-T385 when any path of the merge conflicts outside the generated list the sync exits 1 as today and worktree.synced lists every conflicted path, and a clean sync lists none
level: integration
technique: equivalence classes of the conflict set (unlisted only, listed and unlisted, none) with the event data as the observable
priority: high
risk: "a conflict in a listed file and in another file is regenerated and committed anyway, with the other file left in markers; the sync fails but the event still carries only conflict true, so nobody sees which files conflict; the event lists only the first path, only the unlisted paths or only the listed ones; the list is unordered or holds absolute paths, so it differs between machines; a clean merge writes a non-empty list"
status: active
changed_by: 2026-11-13-ARK-371-1
---

## Objective

Prove that a conflict outside the `generated` list is not hidden by regeneration, that the sync fails as it does today, and that `worktree.synced` records every conflicted path of the merge. Serves ARK-371/AC2.

Expected: When any path outside the `generated` list conflicts, the system shall fail the sync as today (exit 1, the merge aborted, the worktree unchanged), and the `worktree.synced` event shall list every conflicted path in its `conflicts` field.

## Preconditions

- The fixture of ARK-T384, with the entry command `sh gen.sh && touch gen-ran` (so a run of the command leaves a marker): `GEN.txt` listed under `generated`, plus `README.md` and `notes/a.md`, which are not listed.
- A second fixture project with the same repo files and an `ark.yml` that has no `generated` key (`generated` is a project key, so a second worktree of one project cannot lack it).
- Scenarios. `README.md` and `notes/a.md`: the run and the origin target edit the same line of each. `GEN.txt`: as in ARK-T384, the two sides edit different, distant lines of `src.txt` and each regenerates `GEN.txt` (the checksum headers differ), so `GEN.txt` conflicts and `src.txt` merges. Per scenario:
  - (a) `README.md` only;
  - (b) `GEN.txt` and `README.md`;
  - (c) `README.md`, `notes/a.md` and `GEN.txt` (three paths, one in a subfolder);
  - (d) a clean merge (disjoint edits).

## Steps

1. For each scenario run `ark worktree sync <run>` and read the exit code, the message, `git rev-parse HEAD` against the head before the sync, `git status --porcelain`, `MERGE_HEAD`, and the `worktree.synced` event of the repo.
2. For scenario (b) read that `GEN.txt` is not regenerated or committed, and that the marker file `gen-ran` is absent from the worktree (the command did not run).
3. Run scenario (c) in the second fixture project, which has no `generated` key, and read the event.

## Expected results

- (a), (b), (c): exit 1; the head, the tree and the index are the same as before; no `MERGE_HEAD`; the message names the repo and the target as today.
- The event of (a) has `conflict: true` and `conflicts: ["README.md"]`. The event of (b) lists `GEN.txt` and `README.md`, the listed path as well as the other one. The event of (c) lists all three paths, repo-relative, with `/` separators, sorted.
- Step 2: `gen-ran` is absent: the command of the listed entry did not run, because a regeneration with a conflict left elsewhere would only be thrown away by the abort.
- Step 3: the second project records the same three paths. The list does not depend on `generated`.
- (d): the event of the clean merge has no conflict paths (`conflicts` is omitted, not an empty list).

## Screenshot checkpoints

none: CLI integration case; the observables are exit codes, git state and event data.
