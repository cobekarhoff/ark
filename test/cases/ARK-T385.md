---
id: ARK-T385
title: ARK-T385 when any path of the merge conflicts outside the generated list the sync exits 1 as today and worktree.synced lists every conflicted path
level: integration
technique: "equivalence classes of the conflict set (unlisted only, listed and unlisted, several paths) with the event data as the observable, plus a load condition: a fixture delay in each sync pushes the 4 syncs past the 30 s default test limit"
priority: high
risk: "the test dies on the 30 s default limit when the 4 syncs run on a loaded host, so a good sync reads as a failure and a real regression hides in the noise; a conflict in a listed file and in another file is regenerated and committed anyway, with the other file left in markers; the sync fails but the event still carries only conflict true, so nobody sees which files conflict; the event lists only the first path, only the unlisted paths or only the listed ones; the list is unordered or holds absolute paths, so it differs between machines"
status: active
changed_by: 2026-11-20-ARK-577-1
---

## Objective

Prove that a conflict outside the `generated` list is not hidden by regeneration, that the sync fails as it does today, and that `worktree.synced` records every conflicted path of the merge. Serves ARK-371/AC2.

Expected: When any path outside the `generated` list conflicts, the system shall fail the sync as today (exit 1, the merge aborted, the worktree unchanged), and the `worktree.synced` event shall list every conflicted path in its `conflicts` field. The clean merge (no `conflicts` key) is proved by ARK-T305.

## Preconditions

- The fixture of ARK-T384, with the entry command `sh gen.sh && touch gen-ran` (so a run of the command leaves a marker): `GEN.txt` listed under `generated`, plus `README.md` and `notes/a.md`, which are not listed.
- A second fixture project with the same repo files and an `ark.yml` that has no `generated` key (`generated` is a project key, so a second worktree of one project cannot lack it).
- Scenarios. `README.md` and `notes/a.md`: the run and the origin target edit the same line of each. `GEN.txt`: as in ARK-T384, the two sides edit different, distant lines of `src.txt` and each regenerates `GEN.txt` (the checksum headers differ), so `GEN.txt` conflicts and `src.txt` merges. Per scenario:
  - (a) `README.md` only;
  - (b) `GEN.txt` and `README.md`;
  - (c) `README.md`, `notes/a.md` and `GEN.txt` (three paths, one in a subfolder);
  - (d) the same three paths in the second fixture project.
- Opt-in fixture delay: `generatedScenario` takes an optional `syncDelaySeconds` (off by default, so its other callers, the four ARK-T384 tests that call it, which run seven syncs, run as before). Each sync of this case runs with a delay inside the `ark worktree sync` process, so the 4 syncs (a to d) together take longer than the 30 s default test limit. The delay is a fixture input, not a product setting.
- The case carries its own test limit (a literal `timeout` option on the test, at least the 120 000 ms that ARK-T386 uses; ARK-T386 is only the source of that value, it does not call `generatedScenario`). It never relies on the 30 s default.

## Steps

1. For each of the 4 scenarios (a to d) run `ark worktree sync <run>` and read the exit code, the message, `git rev-parse HEAD` against the head before the sync, `git status --porcelain`, `MERGE_HEAD`, and the `worktree.synced` event of the repo.
2. For scenario (b) read that `GEN.txt` is not regenerated or committed, and that the marker file `gen-ran` is absent from the worktree (the command did not run).
3. Scenario (d) runs in the second fixture project, which has no `generated` key; read its event.
4. Run the whole test with the delay on, under the 30 s default (base) and under its own limit (head), and read the result of each.

## Expected results

- (a) to (d): exit 1; the head, the tree and the index are the same as before; no `MERGE_HEAD`; no `gen-ran`; the message names the repo and the target as today.
- The event of (a) has `conflict: true` and `conflicts: ["README.md"]`. The event of (b) lists `GEN.txt` and `README.md`, the listed path as well as the other one. The event of (c) lists all three paths, repo-relative, with `/` separators, sorted.
- Step 2: `gen-ran` is absent: the command of the listed entry did not run, because a regeneration with a conflict left elsewhere would only be thrown away by the abort.
- Step 3: the second project records the same three paths. The list does not depend on `generated`.
- Step 4: with the delay on and no limit of its own the test fails with a timeout; with its own limit all 4 variants (a to d) pass with every assertion above unchanged.

## Screenshot checkpoints

none: CLI integration case; the observables are exit codes, git state and event data.
