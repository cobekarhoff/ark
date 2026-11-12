---
id: ARK-T298
title: ARK-T298 ark services install installs no auto-merger for merge_requests none and removes one left from an earlier setting
level: integration
technique: equivalence classes on merge_requests (none, github, gitlab) and state transition (github then none)
priority: medium
risk: a none project gets an auto-merger that merges nothing or fails each pass; the temp cleaner or sweep is skipped as well; status calls the missing auto-merger an error; a project changed to none keeps a loaded auto-merger
status: active
changed_by: 2026-11-12-ARK-358-1
---

## Objective

For a project whose `ark.yml` says `merge_requests: none`, `ark services install` installs the temp cleaner and the sweep and no auto-merger.

## Preconditions

- Same fakes as ARK-T294. Project `nomr` with `merge_requests: none`, project `ark` with `github`.

## Steps

1. `ark services install --project nomr`. List plists and the fake launchctl log.
2. `ark services status --project nomr`.
3. `ark services install --project ark` (github) as control.
4. Change `ark` to `merge_requests: none` and run install again.
5. `ark services uninstall --project nomr`.

## Expected results

- Step 1: two plists (temp cleaner, sweep); no `auto-merger` plist, no `load` of that label.
- Step 2: auto-merger `not installed`, the other two as installed; exit code 0.
- Step 3: three plists.
- Step 4: the auto-merger label is unloaded and its plist removed (the plan's decision; the case follows it); the other two unchanged.
- Step 5: exit code 0 though the auto-merger never existed.

## Screenshot checkpoints

none: CLI output only, no UI.
