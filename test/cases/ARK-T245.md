---
id: ARK-T245
title: ARK-T245 ark ui install writes the dev.ark.hub LaunchAgent that restarts after a crash and not after exit 0, and loads it
level: integration
technique: equivalence classes (crash exit, clean exit) read from the written plist
priority: high
risk: KeepAlive is a plain true, so a clean exit 0 (for example the hub stopping on purpose) makes launchd start it again; or the plist is written but never loaded, so the hub does not run after install
status: active
changed_by: 2026-11-11-ARK-365-1
---

## Objective

Prove that `ark ui install` writes a hub LaunchAgent that launchd restarts only after a crash, and that it loads the agent. Serves ARK-365.

Expected: When `ark ui install` runs, the system shall write a hub LaunchAgent that restarts after a crash and not after a clean exit.

## Preconditions

- A scratch `HOME` and a scratch `ARK_HOME`.
- A fake `launchctl` in a scratch directory that appends its arguments to a log file. `ARK_LAUNCHCTL` points at it and `PATH` holds only that directory.

## Steps

1. Run `ark ui install` with that environment.
2. Read `~/Library/LaunchAgents/dev.ark.hub.plist` under the scratch `HOME`.
3. Read the fake `launchctl` log.

## Expected results

- The command exits 0.
- The plist has `RunAtLoad` true.
- The plist has `KeepAlive` as a dict with `SuccessfulExit` false, so launchd restarts the hub after a non-zero exit or a crash and not after exit 0.
- The plist program arguments are the current runtime, `cli/ark.ts` and `ui`.
- The log holds exactly one line: `load -w <plist path>`.

## Screenshot checkpoints

None. There is no screen to check.
