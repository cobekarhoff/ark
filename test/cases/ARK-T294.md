---
id: ARK-T294
title: "ARK-T294 ark services install writes and loads one LaunchAgent per service, a second install leaves one copy, uninstall removes them"
level: integration
technique: "state transition (absent, installed, reinstalled unchanged, changed, uninstalled) and equivalence classes (per service, per project)"
priority: high
risk: "install writes a plist without RunAtLoad, KeepAlive (that restarts after exit 0) or a project log; a second install loads the same label again (launchctl load fails) or leaves two copies; labels collide with dev.ark.hub/dev.ark.proxy or across projects; uninstall leaves a loaded or written agent; the project autocommit plist passes an interval of 300 s or more, none, or `--once`, so a change waits 5 minutes or longer or the job runs one pass per restart"
status: active
changed_by: 2026-11-14-ARK-482-1
---

## Objective

`ark services install --project <name>` writes and loads one LaunchAgent each for the auto-merger, the temp cleaner, the sweep and the project autocommit, with `RunAtLoad`, `KeepAlive` that restarts after any exit, and a log in the project folder. The autocommit passes an interval under 300 s to its script, so a change is committed less than 5 minutes after it (ARK-482 AC1). Install twice leaves one copy of each. `uninstall` unloads and removes them.

## Preconditions

- A fake `launchctl` in a scratch directory that appends its arguments to a log and keeps a list of loaded labels (`load` of a loaded label exits non-zero, as the real one does). The existing ARK-T245 fake and `ARK_LAUNCHCTL` hook are the pattern.
- A temporary LaunchAgents folder and a temporary `ARK_HOME`; a project `ark` with `merge_requests: github` and a second project `other`.

## Steps

1. Run `ark services install --project ark`. Read the four plists and the fake launchctl log.
2. Run the same command again. Read the log and the folder.
3. Change the install environment (a different PATH) and run install again.
4. Run `ark services install --project other`.
5. Run `ark services uninstall --project ark`.
6. Run `ark services uninstall --project ark` again.
7. Check the `dev.ark.hub` and `dev.ark.proxy` plists are untouched throughout.

## Expected results

- Step 1: exactly four plists, labels `dev.ark.ark.auto-merger`, `dev.ark.ark.temp-cleaner`, `dev.ark.ark.sweep`, `dev.ark.ark.project-autocommit` (or the one per-project, per-service scheme the plan fixes). Each has `RunAtLoad` true, a `KeepAlive` that also restarts after exit 0 (not `SuccessfulExit:false`), `ARK_PROJECT=ark`, a `ProgramArguments` script path inside the pinned clone resolved from the module, and `StandardOutPath`/`StandardErrorPath` under the project folder. The autocommit plist runs `project-autocommit.sh` with the workspace and then an interval argument that is a positive integer below 300 (the 5-minute bound of ARK-482 AC1: 300 or more fails), and no `--once`. The log shows one `load` for each label.
- Step 2: unchanged plists, no second `load`, still four files and four loaded labels.
- Step 3: plist updated, log shows `unload` then `load` for that label; still one copy of each.
- Step 4: four more labels carrying `other`; the `ark` labels are unchanged.
- Step 5: log shows `unload` for the four `ark` labels, the four files are gone, the `other` agents remain.
- Step 6: exit code 0, no error.
- Step 7: hub and proxy plists byte-identical.

## Screenshot checkpoints

none: CLI output only, no UI.
