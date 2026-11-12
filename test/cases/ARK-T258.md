---
id: ARK-T258
title: ARK-T258 ark ui serves the hub from hub/
level: integration
technique: smoke of the real entry point
priority: medium
risk: "ark ui starts but serves no hub page or no snapshot, for example after the hub source moves or the bundle fails to build"
status: active
changed_by: 2026-11-11-ARK-354-1
---

## Objective

Prove `ark ui` serves the hub built from `hub/`.

## Preconditions

- `test/hub.test.ts`, isolated `ARK_HOME` and fake tools; the hub source is in `hub/`.

## Steps

1. Start `ark ui --port 0` and read the port from its output.
2. Request `/api/snapshot` and `/`.

## Expected results

- When `ark ui` starts, the system shall serve the hub from `hub/`: `/api/snapshot` answers HTTP status 200 and `/` holds the page root `<div id="root"></div>`.

## Screenshot checkpoints

None.
