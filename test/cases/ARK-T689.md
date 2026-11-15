---
id: ARK-T689
title: ARK-T689 auto-merger does not merge a run that is closed when ark status is read again
level: integration
technique: "state transition (merge_requests_open in the list, closed on the per-run re-read)"
priority: high
risk: "the script trusts the list call and merges a PR whose run closed in between, so a run the human closed or superseded is merged anyway"
status: active
changed_by: 2026-11-15-ARK-506-1
---

## Objective

Prove that `scripts/auto-merger.sh` asks `ark status <run>` again right before `gh pr merge` and skips the run when that call says the phase is not `merge_requests_open`.

## Preconditions

- Fake `gh`, `osascript` and `sleep` in a bin folder (as `test/chief-scripts.test.ts`); the fake `sleep` counts passes and ends the script after 2.
- One run, `2026-11-02-ARK-41-1`, with a `merge_request.opened` event (PR 41), `retro.md` and a ticket file in status `ready`, so nothing but the phase can hold it. PR 41 is CLEAN: the fake `gh` answers CLEAN for every PR but 12, and the re-read is reached only for a CLEAN PR.
- A fake `ark`: `ark status` (list) prints `<run> merge_requests_open`, `ark status <run>` prints `phase: closed`, and `ark merge-request status` runs the real `cli/ark.ts`.

## Steps

1. Run `auto-merger.sh <workspace> 1` with `ARK_PROJECT=demo`; the fake `sleep` stops it after the second pass.
2. Read the pass count, the `gh pr merge` log and stdout.

## Expected results

- Two passes ran.
- No `gh pr merge` call.
- Stdout has no `CHANGE:` line.

## Screenshot checkpoints

none: script, log and stdout output, no UI.
