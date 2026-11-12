---
id: ARK-T286
title: ARK-T286 post_mr exits 2 and posts nothing when an upload fails or gh has no --attach
level: integration
technique: error guessing and state transition: failure on the first and on the last of 2 uploads, and the version probe before any write
priority: high
risk: a failed upload still creates the MR with a local path in the body, a failure on file 2 posts after file 1 was uploaded, `gh` older than 2.99.0 fails only after `gh pr create` ran or exits 1, the message does not name the file or `2.99.0`
status: active
changed_by: 2026-11-12-ARK-399-1
---

## Objective

Prove that when a `glab` upload fails, or `gh pr create --help` (create) or `gh pr edit --help` (update) has no `--attach`, `post_mr.ts` exits 2, names the file or the needed `gh` version, and runs no create or update. Serves ARK-399/AC3.

Expected: If an upload fails or `gh` has no `--attach` flag, then `post_mr.ts` shall exit 2, name the file or `gh` 2.99.0, and create or change no MR.

## Preconditions

- Fixture run as in ARK-T284/ARK-T285.
- Fake `glab` whose upload exits non-zero for the second file (variant: the first file).
- Fake `gh` whose `pr create --help` lists no `--attach` (variant: `pr edit --help` for an open PR); the fake records every call.
- Control: `gh` without `--attach` and a body that names no existing local file.

## Steps

1. Run `post_mr.ts --confirmed` on GitLab with the failing second upload. Read stdout, stderr, exit code and the call log.
2. Repeat with the failing first upload.
3. Run it on GitHub with the `gh` that has no `--attach`, for a new PR, then for an open PR.
4. Run the control: old `gh` and a body with no existing local file.

## Expected results

- Exit code 2 in every failing case.
- The message names the failing file path (upload cases) or `2.99.0` (version cases).
- The call log holds no `mr create`, `mr update`, `pr create` or `pr edit` call; for GitHub the help probe is the only `gh` call after the lookups.
- The control proceeds as today: `gh pr create` runs, exit 0, and no `--help` probe call is recorded. The probe runs only when the body names at least one existing local file.

## Screenshot checkpoints

None. The surface is CLI output, exit codes and recorded host calls from a fake; no screenshot applies.
