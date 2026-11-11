---
id: ARK-T246
title: ARK-T246 merge-request open refuses a head that changed since the test, with the run id in the next command, then opens after a passing ark test
level: integration
technique: state transition (tested head / head moved / retested)
priority: high
risk: merge-request open pushes and opens an MR for a commit that no ark test run covered, or refuses without naming the run id so the person cannot tell which command to run next
status: active
changed_by: 2026-11-11-ARK-407-1
---

## Objective

Prove that `ark merge-request open` refuses when a repo head differs from the head recorded by the last `ark test`, names the repo, both heads and the run id, pushes and records nothing, and opens normally after `ark test` passes again.

## Preconditions

- Real git; a temp bare `origin`, a run worktree on the run branch, and a fake `gh` that records its calls.
- A run that passed `ark test` at the current head.
- A commit made in the worktree after that test.

## Steps

1. Read the head tested and the head now. Run `ark merge-request open <run>`.
2. Read the exit code, stderr, the fake `gh` calls, `events.ndjson` and the branches on `origin`.
3. Run `ark test <run>`, then `ark merge-request open <run>` again.
4. Read the exit code, the `gh` create calls and the `merge-request.opened` events.

## Expected results

- When the head changed since the last test, the system shall refuse to open the merge request: exit 1, and stderr names the repo, `tested <sha>`, `now <sha>` and ends with `run ark test <run> again`.
- The refused open shall push no branch to `origin`, make no `gh` call and append no event to `events.ndjson`.
- After a passing `ark test`, the open shall exit 0, create one merge request and record one opened event, with no escalation gate.

## Screenshot checkpoints

none: CLI integration case; the observables are exit codes, stderr, the origin refs and run events.
