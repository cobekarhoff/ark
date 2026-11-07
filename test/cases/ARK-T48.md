---
id: ARK-T48
title: ARK-T48 merge-request open pushes and posts one ready MR per repo on GitHub in dependency order, with the run title and body
level: integration
technique: state transition (no MR, MR posted, rerun) over two repos on GitHub
priority: medium
risk: a repo opens no MR, opens in the wrong order, takes the ticket title or the AC text as title or body, or a rerun creates a second MR
status: active
changed_by: 2026-11-06-ARK-316-1
---

## Objective

Prove that merge-request open pushes and posts one ready MR per repo on GitHub in dependency order, with the run title and body. This case replaces the old id ARK-155-AC1 to AC5 (GitHub half), converted when ARK-316 changed the title and body assertions.

## Preconditions

- A fixture run with repos core and app (app needs core) and docs with no commits, remotes on GitHub, and a fake `gh` that records calls and keeps open PRs.

## Steps

1. Run `ark merge-request open <run>`.
2. Read each `gh pr create` call: title, head, body, assignee.
3. Check the pushed branches and the `merge_request.opened` events.
4. Run it again with no change.

## Expected results

- One `gh pr create` per repo with commits, core before app, head `ark/<run>`, title `<ticket id>: <ticket title>` (the title is 72 characters or less).
- The body is the pr-writing body: it names the ticket id, does not paste AC texts, and the app body has `Depends on #1` while the core body has no `Depends on` line.
- The branch reached each origin, docs opened nothing, and the events hold the two URLs.
- The rerun creates no PR and appends no event.

## Screenshot checkpoints

none: integration case on CLI output and host calls; no UI surface.
