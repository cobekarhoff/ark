---
id: ARK-T690
title: ARK-T690 auto-merger prints one HELD line for a held PR over 3 passes, no CHANGE line, and the script keeps running
level: integration
technique: "state transition (held in pass 1, still held in later passes) and equivalence class (hold reason: no final report, ticket superseded)"
priority: high
risk: "a held PR is merged (no retro.md, or a superseded ticket that has a retro.md), or its HELD line prints every pass and floods the log, or the script exits after the hold instead of looping"
status: active
changed_by: 2026-11-15-ARK-506-1
---

## Objective

Prove that a PR the auto-merger holds prints `HELD: <run> #<number> <reason>` to stderr once however many passes run, prints no `CHANGE:` line, makes no `gh pr merge` call, and that only the loop's sleep ends the script. Two hold reasons are covered, one test each: `no final report` (the run has no `retro.md`) and `ticket superseded` (the run has a `retro.md` and its ticket file has status `superseded`).

## Preconditions

- Fake `gh`, `osascript` and `sleep` in a bin folder; the fake `sleep` counts passes and ends the script after 3 (reason `no final report`) or 2 (reason `ticket superseded`).
- Reason `no final report`: one run, `2026-11-02-ARK-51-1`, with a `merge_request.opened` event (PR 51), no `retro.md` and the real `ark` (`cli/ark.ts`).
- Reason `ticket superseded`: one run, `2026-11-02-ARK-52-1`, with a `merge_request.opened` event (PR 52), a `retro.md` and a ticket file in status `superseded`; the real `ark`.

## Steps

1. Run `auto-merger.sh <workspace> 1` with `ARK_PROJECT=demo`; the fake `sleep` stops it after the last pass.
2. Read the pass count, stderr, stdout and the `gh pr merge` log.

## Expected results

- Reason `no final report`: three passes ran, the script ended only through the fake `sleep`, not by itself; stderr has exactly one `HELD:` line, `HELD: 2026-11-02-ARK-51-1 #51 no final report`.
- Reason `ticket superseded`: two passes ran; stderr has exactly one `HELD:` line, `HELD: 2026-11-02-ARK-52-1 #52 ticket superseded`.
- Stdout has no `CHANGE:` line.
- No `gh pr merge` call.

## Screenshot checkpoints

none: script, log and stderr output, no UI.
