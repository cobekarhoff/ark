---
id: ARK-T386
title: ARK-T386 the ark.yml example of the Ark project in the docs lists docs/reference/cli.md with bun scripts/cli-reference.ts, and a sync with that entry regenerates the file for a run that changed cli/ark.ts on both sides
level: integration
technique: use case (the documented entry run against the real generator)
priority: high
risk: "the documented example does not name the file or the command, so the project ark.yml copied from the docs never regenerates and every cli.md conflict still starts a merge worker; the documented entry is not valid for ark.yml; the command fails or reads the wrong tree when it runs mid-merge, so the generated block is stale or empty"
status: active
changed_by: 2026-11-13-ARK-371-1
---

## Objective

Prove that the Ark example in the docs carries the entry that removes the most frequent conflict (`docs/reference/cli.md`, 54% of resolved conflicts), and that this exact entry makes `ark worktree sync` succeed when both sides of a run changed `cli/ark.ts`. Serves ARK-371/AC3.

Expected: The ark.yml example of the Ark project in the docs shall list `docs/reference/cli.md` with the command `bun scripts/cli-reference.ts`; when a run and the target both changed `cli/ark.ts`, `ark worktree sync` with that entry shall regenerate `docs/reference/cli.md`, commit the merge and succeed.

## Preconditions

- `docs/how-to/bootstrap-a-project.md`, the section that shows the `ark.yml` of the Ark project (`workspace: /Users/you/Dev/abbott/ark`).
- A fixture repo, built in the temp dir with real git and a real origin, that holds every tree `cli/ark.ts` imports at the checked-out head: `cli/`, `scripts/`, `skills/`, `hub/` (without its `node_modules`) and `docs/reference/cli.md`; with a `node_modules` symlink to the real one (`cli/ark.ts` needs `typescript/unstable/*`). A `git clone --shared` of the checked-out head is equivalent. `bun scripts/cli-reference.ts` exits 0 in this fixture (about 7 s).
- The `ark.yml` of the fixture project is the YAML block of the docs example with `workspace` replaced by the fixture path (`validateConfig` refuses a workspace that is not an existing directory); the `generated` list stays verbatim from the docs, not retyped.
- The run's commit changes `cli/ark.ts` (one hunk) and the description of one command in `cli/commands/*.ts`, and regenerates `cli.md` in its own commit. origin's target commits a change to another hunk of `cli/ark.ts` and to the description of a command whose `cli.md` section is adjacent to the run's, and regenerates `cli.md` too. So `cli/ark.ts` and `cli/commands/*.ts` auto-merge and only the generated block of `cli.md` conflicts. Check that a plain `git merge` of the target in the fixture conflicts only in `docs/reference/cli.md`.
- Timing: the fixture runs the generator four times (run side, target side, the sync, the re-check), about 7 s each plus the copy, near the 30 s `setDefaultTimeout` of `test/sync.test.ts`. The case needs its own test file or a per-test timeout.

## Steps

1. Read the YAML block of the Ark example in `bootstrap-a-project.md`, parse it, and read its `generated` list. Check that it is accepted by the `ark.yml` validation (the project file loads in the fixture).
2. Run `ark worktree sync <run>` in the fixture. Read the exit code, `git log --merges -1 --format=%P`, `git status --porcelain`, `MERGE_HEAD`, the `worktree.synced` event, and `docs/reference/cli.md`. Run `bun scripts/cli-reference.ts` again in the fixture and diff the file.

## Expected results

- Step 1: the list holds the entry `path: docs/reference/cli.md`, `command: bun scripts/cli-reference.ts`, and the validation accepts it.
- Step 2: exit 0; the head is a merge commit of the earlier head and the target tip; `cli.md` has no conflict marker and holds both description changes (the generated block follows the merged `cli/commands/`); a second run of the generator changes nothing; the tree is clean; the event has `conflict: false` and `target_commit`; `cli/ark.ts` was auto-merged, not listed, and not regenerated.

## Screenshot checkpoints

none: CLI integration case; the observables are exit codes, files and git state.
