---
id: ARK-T384
title: ARK-T384 ark worktree sync regenerates a conflicted file that ark.yml lists under generated, commits the result as the merge and succeeds, and aborts as today when the command fails, leaves a conflict marker or leaves the tree dirty, or when nothing is unmerged
level: integration
technique: state transition (conflicted, regenerated, committed) with equivalence classes of the command outcome (writes the file, fails, leaves markers, writes another file) and of the unmerged list (all listed, empty)
priority: high
risk: "sync starts a merge worker for a conflict that a command could rewrite; the regenerated merge is committed with conflict markers still in the listed file (the command is a no-op, or the conflict sits in a hand-written part the command keeps); a failing command, or one that dirties another file, still leaves a commit or a half merge; a failed merge with no unmerged path (an empty list is vacuously 'only listed paths') runs the command and commits what it wrote; a dirty check that counts an untracked entry the worktree held before the sync aborts a good regeneration (a multi-repo worktree holds untracked symlinks of the mirror and of nested worktrees); the regenerated merge records conflict true or no target commit, so --merge is unlocked and ark test keeps the old base; an invalid generated entry is accepted and fails only when a conflict happens"
status: active
changed_by: 2026-11-13-ARK-371-1
---

## Objective

Prove that when every conflicted path of the target merge is listed under `generated` in `ark.yml`, `ark worktree sync` runs each entry's command in the repo worktree, adds the listed paths, commits the merge and exits 0; and that any other outcome leaves the worktree as a plain conflicting sync does today. Serves ARK-371/AC1.

Expected: When `ark worktree sync` finds conflicts only in paths listed under `generated`, the system shall run the commands, commit the result as the merge and succeed; if a command fails or leaves the tree dirty, or a listed path still holds a conflict marker, or no path is unmerged, the system shall abort the merge as today.

## Preconditions

- Fixture of `test/sync.test.ts` (`makeWorkspace` with a real git origin, a run worktree on the run branch, `worktree.created` recorded), with no `cli/` or `docs/`.
- The repo holds `src.txt` (six lines, the source) and `GEN.txt`, a file written from it by `gen.sh` (`{ cksum < src.txt; cat src.txt; } > GEN.txt`: a checksum header line, then the content of `src.txt`; `gen.sh` is committed), both committed on `main`. A plain `cp` generator would make `GEN.txt` merge exactly as `src.txt` does, so both would conflict or neither would; the header line is what makes only `GEN.txt` conflict.
- The run commits an edit of line 1 of `src.txt` and regenerates `GEN.txt`. origin's target then commits an edit of line 6 of `src.txt` and regenerates `GEN.txt`. The two checksum headers differ, so `git merge` of the target into the run branch exits 1 with `GEN.txt` the only unmerged path, and `src.txt` auto-merges (checked in a temp repo: unmerged list is `GEN.txt` alone, `src.txt` is staged as merged). Editing adjacent lines instead would conflict `src.txt` too, so keep the two edits apart.
- `ark.yml` has `generated: [{ path: GEN.txt, command: sh gen.sh }]`.
- Variants of the entry command (one sync each, the same conflict each time): `true` (writes nothing, markers stay), `false` (exit 1), `sh gen.sh && echo x > other.txt` (writes an unlisted file), `sh gen.sh && echo x >> src.txt` (modifies a tracked, unlisted file; `src.txt` is already staged as merged, so a plain `git merge --abort` fails here with `Entry 'src.txt' not uptodate`, and the sync must restore the head and the index another way, for example `git reset --hard <head before the sync>`).
- Before every sync the worktree holds untracked entries the sync did not make: a symlink to a folder outside the repo (as `linkUntouched` leaves in a multi-repo worktree) and a scratch file `scratch.txt`. Neither is in `.gitignore`.
- A variant where the merge fails with no unmerged path: the run's committed `GEN.txt` is hand-edited so it differs from `gen.sh` run on the run's own `src.txt`; an untracked `new.txt` in the worktree that origin's target also adds (so git refuses the merge with `untracked working tree files would be overwritten`, exit 2, and nothing is unmerged, no `MERGE_HEAD`); `ark.yml` has `generated: [{ path: GEN.txt, command: sh gen.sh && touch gen-ran }]`. A buggy sync that runs the command finds a changed `GEN.txt` to commit.
- Invalid `ark.yml` variants: an entry with an empty `path`, an entry with an empty `command`, two entries with the same `path`.

## Steps

1. Run `ark worktree sync <run>` with `command: sh gen.sh`. Read the exit code, stdout, `git log --merges -1 --format=%P`, `git status --porcelain`, `GEN.txt`, `MERGE_HEAD`, the untracked symlink and `scratch.txt`, the origin ref of the run branch, and the new `worktree.synced` event.
2. Reset the fixture to the conflicting state and run the sync with each variant command (`true`, `false`, `sh gen.sh && echo x > other.txt`, `sh gen.sh && echo x >> src.txt`). After each, read the exit code, the message, `git rev-parse HEAD` against the head before the sync, `git status --porcelain`, `MERGE_HEAD`, and the `worktree.synced` event.
3. Run the sync in the repo with the untracked `new.txt` clash, and read the same observables, plus whether the marker file `gen-ran` exists in the worktree and the `worktree.synced` event.
4. Run `ark status` with each invalid `generated` entry, and read the exit code and the message.
5. Reset the fixture to the conflicting state with `command: sh gen.sh && touch gen-ran`, write `UNCOMMITTED WORK` into the tracked, unrelated `notes/a.md` without staging it, and run the sync. Read the exit code, `notes/a.md`, `HEAD`, `MERGE_HEAD`, `gen-ran` and the `worktree.synced` event.

## Expected results

- Step 1: exit 0; the head is a merge commit whose two parents are the earlier head and the origin target tip; `GEN.txt` holds the output of `gen.sh` run on the merged tree and no `<<<<<<<` line; `git status --porcelain` lists only the entries untracked before the sync (the symlink and `scratch.txt`): the sync commits although they are there, because an untracked entry that existed before the sync does not make the tree dirty (run lead decision; `dirtyLines` in `cli/worktree.ts` skips only symlinks and nested worktrees, so the new check must also skip an untracked file that existed before); there is no `MERGE_HEAD`. The event has `conflict: false`, `target_commit` equal to the origin target tip, and `conflicts: ["GEN.txt"]` (the paths that conflicted before the regeneration; a clean merge omits `conflicts`, see ARK-T385), so the repo is not in `sync_conflicts`, `--merge` is refused for it, and `ark test` takes its base from the tip. The output has the `<repo>  <target>  <HEAD>` line, and the regeneration (repo, path, command) is named on stderr only.
- Step 2: for each variant the exit code is 1; the merge is aborted: no new commit (`HEAD` equals the head before the sync), no `MERGE_HEAD`, and the tracked files and the index are as before the sync (`GEN.txt` is back to its pre-sync content); the message names the repo and the target. The event has `conflict: true` and no `target_commit`; the repo is in `sync_conflicts`. An untracked file the command wrote (`other.txt` in the third variant) stays, and so do the symlink and `scratch.txt`: the sync never runs `git clean`, so the worktree's own untracked files are never touched. The command that writes a new unlisted file (`other.txt`) and the one that modifies a tracked unlisted file (`src.txt`) each make the tree dirty, so the sync aborts for them, while the untracked entries held before the sync alone never do. A conflict marker left in a listed path is refused even though the command exits 0.
- Step 3: exit 1; the message names the repo and the target; `HEAD` equals the head before the sync, no merge commit, no `MERGE_HEAD`, and `GEN.txt` still holds its hand-edited content; the marker file `gen-ran` is absent (the command did NOT run: an empty unmerged list never counts as 'only listed paths'), and the tracked files and the index are as before. The event has `conflict: true`, no `target_commit`, and no `conflicts` key (or an empty one: no path conflicted); the repo is in `sync_conflicts`.
- Step 4: the command exits non-zero and the message names the `generated` field and the entry: an empty `path`, an empty `command` and a duplicate `path` are each refused before any sync runs.
- Step 5: exit 1 as with no `generated` key; the sync took the plain abort (no command ran, `gen-ran` absent): `notes/a.md` still holds `UNCOMMITTED WORK`, `HEAD` equals the head before the sync, no `MERGE_HEAD`. The event has `conflict: true`, no `target_commit` and `conflicts: ["GEN.txt"]`; the repo is in `sync_conflicts`. A reset to the head before the sync would wipe the edit, so the sync must not regenerate when a tracked path outside the conflict is already modified.
- Step 1 also: the message of the merge commit has no `# Conflicts:` line.

## Screenshot checkpoints

none: CLI integration case; the observables are exit codes, git state, files and events.
