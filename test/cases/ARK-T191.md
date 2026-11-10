---
id: ARK-T191
title: ARK-T191 ark test exits 1 with "base checkout missing: <path>" when the base folder vanishes during the base suites, with no posix_spawn ENOENT
level: integration
technique: state transition (folder present, then gone) at each suite-spawn boundary
priority: high
risk: a vanished base folder surfaces as "ENOENT posix_spawn 'git'" with a stack or exit code other than 1, so the cause (temp cleaner deleted the checkout) is hidden; or the check runs only before the first suite and misses a deletion during a later suite; or compose down / rmSync of the missing root hides the message with its own ENOENT
status: active
changed_by: 2026-11-10-ARK-404-1
---

## Objective

When the base checkout folder is gone while `ark test` runs the base suites, the command exits 1 and prints `base checkout missing: <path>`; no ENOENT of posix_spawn is printed.

## Preconditions

- A fixture run and project whose `ark.yml` has two fake suites in the same repo, run in a non-refactor kind with a changed test file so the base run happens (see ARK-T1, ARK-T119).
- The first fake suite deletes the base checkout (path from its cwd's parent, or a marker the test reads) while it runs, and then finishes. The second suite must still be due.
- `ark test` runs detached: read exit code and output with `ark test <run> --wait` or the runner log.

## Steps

1. Run `ark test <run>` with the fake suite 1 deleting the base folder.
2. Read output and exit code.
3. Repeat with a single suite that deletes the folder and exits 0 (no later suite spawn), the check must still fire after the last suite.
4. Repeat with a stack (compose) configured, so `compose down` runs with a missing cwd in the cleanup.
5. Control: run with the folder intact.

## Expected results

- Steps 1, 3, 4: exit code 1; output contains `base checkout missing: <absolute path of the folder>`; output does not contain `ENOENT` or `posix_spawn`; in step 4 the message is not replaced by a compose error.
- Step 5: exits as before (base run completes; no new message).
- The head result of the run is not lost: head evidence stays written.

## Screenshot checkpoints

none: CLI output only; the expected text is in `mockups/base-missing.md`.
