---
id: ARK-T24
title: ARK-T24 open then update after a fixed P0 removes the P0 from the body
level: integration
technique: state transition (opened, new head, updated) with before and after evidence
priority: high
risk: a post-MR round leaves a stale body that still lists a fixed P0 (as ARK-293 PR 121 did), the second run prints already open, the MR opens as Draft, or a --confirmed flag is needed
status: active
changed_by: 2026-11-06-ARK-316-1
---

## Objective

Prove that `ark merge-request open` posts a ready MR from the ledger and, after a new head, updates the body of each open MR instead of printing "already open". Serves ARK-316/AC8. This case lives in `test/merge-request.test.ts`.

Expected: When a new head follows `ark test`, the system shall update the body of each open MR.

## Preconditions

- A fixture run past the plan gate answer, with a fake `gh`/`glab` that records calls, and one open P0 in `findings/<step>.md`.
- The fixture meets the `assertShippable` prerequisites, so a refusal there cannot hide the case: a `test.completed` event with `passed: true` and every non-manual AC `passing`; an `ok` gate for each manual AC; the head of every repo equal to the head of that last test run; each AC string present in a tracked file at head; and complete ARK-312 evidence under `results/evidence/` for each test case.
- A fixture run with two MRs (two repos) for the multi-MR step.

## Steps

1. Run `ark merge-request open <run>` with no `--confirmed` flag. Read the create call and the body. This body is the before evidence.
2. Check the run state: the run is in `merge_requests_open`.
3. Fix the P0 with a new commit, add a later review file with `No findings.`, and run `ark test <run>` so the head is new and the last test result passes with complete evidence at that head.
4. Run `ark merge-request open <run>` again. Read the calls and the output. This body is the after evidence.
5. Run it a third time with no new head.
6. Repeat steps 3-4 on the run with two open MRs.
7. Run `bun test test/merge-request.test.ts`.

## Expected results

- The first run needs no `--confirmed` flag (the plan gate answer is the go-ahead). The MR is created ready, not Draft, from the ledger body, and the body passed lint.
- The first body lists the P0 (before evidence).
- After the new head the second run updates the body of the open MR. It does not print "already open". The updated body does not list the fixed P0 (after evidence).
- With no new head the third run changes nothing.
- With two open MRs both bodies are updated.
- `bun test test/merge-request.test.ts` exits 0.

## Screenshot checkpoints

None. The surface is CLI output and Markdown text; no screenshot applies.
