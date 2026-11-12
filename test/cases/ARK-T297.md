---
id: ARK-T297
title: ARK-T297 ark services status and ark chief state show each service as not installed, loaded or running with pid and last log line
level: integration
technique: state transition and equivalence classes (not installed, loaded without pid, running with pid; log empty, log with lines)
priority: high
risk: status calls a loaded-but-not-running service running, or shows no pid; the log tail is missing or from another project; ark chief state and ark services status print different text; a missing service plist is reported as an error
status: active
changed_by: 2026-11-12-ARK-358-1
---

## Objective

`ark services status --project <name>` and the services section of `ark chief state` print for each of the three services the state `not installed`, `loaded` or `running`, the pid when running, and the last line of its log. Both print the same text.

## Preconditions

- Fake `launchctl` whose `list <label>` prints the real format: exit 113 with an error for an unknown label; a dict with `"Label"` and no `"PID"` for loaded; with `"PID" = 4242;` for running.
- Temporary `ARK_HOME` and LaunchAgents folder; project `ark`; log files under the project folder.

## Steps

1. Nothing installed. Run `ark services status --project ark` and `ark chief state`.
2. Install the three (fake launchctl). Set the auto-merger loaded without pid, temp cleaner running pid 4242, sweep unknown. Write several lines to the cleaner's log, none to the others.
3. Run both commands again.
4. Make the sweep running with pid 777 and a log whose last line is empty after trailing newline.
5. Compare the services block of `chief state` with the status output.

## Expected results

- Step 1: all three `not installed`, exit code 0, no log line shown.
- Step 3: auto-merger `loaded` with no pid; temp cleaner `running`, pid 4242, last non-empty log line; sweep `not installed`.
- Step 4: sweep `running` pid 777 and the last non-empty log line.
- Step 5: identical text for each service.
- The old `ark chief state` snapshots (test/chief.test.ts, ARK-T115 and the cases at lines 343, 611) are updated for the new section; the hub parser of that output is checked.

## Screenshot checkpoints

none: CLI output only, no UI.
