---
id: ARK-T297
title: "ARK-T297 ark services status and ark chief state show each service as not installed, loaded or running with pid and last log line"
level: integration
technique: "state transition and equivalence classes (not installed, loaded without pid, running with pid; log empty, log with lines)"
priority: high
risk: "status calls a loaded-but-not-running service running, or shows no pid; the log tail is missing or from another project; ark chief state and ark services status print different text; a missing service plist is reported as an error"
status: active
changed_by: 2026-11-19-ARK-533-1
---

## Objective

`ark services status --project <name>` and the services section of `ark chief state` print for each of the four services (auto-merger, temp cleaner, sweep, project autocommit) the state `not installed`, `loaded` or `running`, the pid when running, and the last line of its log. Both print the same text for the services (ARK-533 adds a Hub line with a different answer time on each call; the case compares the service rows without it, and the Hub line is owned by ARK-T702).

## Preconditions

- Fake `launchctl` whose `list <label>` prints the real format: exit 113 with an error for an unknown label; a dict with `"Label"` and no `"PID"` for loaded; with `"PID" = 4242;` for running.
- Temporary `ARK_HOME` and LaunchAgents folder; project `ark`; log files under the project folder.

## Steps

1. Nothing installed. Run `ark services status --project ark` and `ark chief state`.
2. Install the four (fake launchctl). Set the auto-merger loaded without pid, temp cleaner running pid 4242, sweep unknown, project autocommit running pid 555 with a log line. Write several lines to the cleaner's log, none to the auto-merger or the sweep.
3. Run both commands again.
4. Make the sweep running with pid 777 and a log whose last line is empty after trailing newline.
5. Compare the services block of `chief state` with the status output, each with its Hub line removed.

## Expected results

- Step 1: all four `not installed`, exit code 0, no log line shown.
- Step 3: auto-merger `loaded` with no pid; temp cleaner `running`, pid 4242, last non-empty log line; sweep `not installed`; project autocommit `running`, pid 555, its log line.
- Step 4: sweep `running` pid 777 and the last non-empty log line.
- Step 5: identical text for each service row (the four service lines and their log lines), byte for byte once the Hub line is removed from each. The Hub line is checked only for its shape (equal after the numbers are replaced), in ARK-T702 and in the updated `test/chief.test.ts` test titled `ARK-T297` (lines 376-395).
- The `not installed` count of the Services section in `ark chief state` (`test/chief.test.ts:240`, ARK-T115, `toHaveLength(3)`) becomes 4. Nothing else parses that section: no file under `hub/` reads it.

## Screenshot checkpoints

none: CLI output only, no UI.
