---
id: ARK-T749
title: ARK-T749 the refresh of an open MR reads the no-code rule at the pushed head, refuses a quick test after a code commit, and drops the Full suite line after a full test
level: integration
technique: state transition (no-code quick, MR open, code commit, quick, refresh refused, full, refresh) on one run
priority: high
risk: "the no-code check sits in the new-MR branch of `mergeRequestOpen` or reads a value stored at the first open, so the refresh of an open MR pushes a code commit on a quick test; or the ledger's no-code fact is read from the first open, so the refreshed body still says `Full suite: CI (no code file in this diff)` for a diff that now holds code"
status: active
changed_by: 2026-11-20-ARK-604-1
---

## Objective

Prove that the no-code rule is applied on every push of `ark merge-request open`, the refresh of an open MR included, and that the `Full suite:` line follows the head being pushed. Serves ARK-604/AC1 (the line belongs to a no-code head only) and the repo rule that a check guarding a push covers the refresh of an open MR.

Authoring gate:

1. Protects: `assertShippable` (through `checkStage`) runs before the push loop for a refresh as for a new MR, and `buildBody` gets the no-code fact of the head it pushes.
2. Fails when: the check is placed in the new-MR branch only (step 2 pushes and edits the body), or the no-code fact is cached in the run folder or the event of the first open (step 3 keeps the line).
3. Existing proof misses it: ARK-T748 opens a new MR only; ARK-T57 and ARK-T680 refresh a body on a full result, with no quick result and no `Full suite:` line. This is a distinct lifecycle (an open MR, then a new head), not a second owner of the refusal texts of ARK-T750.
4. No test-only export, flag or hook: the real `ark` process, real `ark test`, and the fake forge that records `gh pr create` and `gh pr edit`.

## Preconditions

- Fixture A of ARK-T748 (reuse case `FAKE-T1` with a passing test `test/existing.test.ts` at base, own commit of Markdown only). The suite shape may differ from ARK-T748 (this case needs no zero-test quick run), as long as the full run of step 3 writes `results/evidence/FAKE-T1/{base,head}/result.json`; the test asserts both files before the open of step 3, as ARK-T373 does.
- The test records the remote branch tip once, after the first open, and compares it after the refused open (it must not move) and after the refresh of step 3 (it must contain HEAD).

## Steps

1. Run `ark test <run> --quick`, then `ark merge-request open <run>`. Read the body of the `gh pr create` call.
2. Commit `src/a.ts` in the worktree. Run `ark test <run> --quick` (exit 0), then `ark merge-request open <run>`. Read the exit code, stderr, the remote branch tip and the `gh pr edit` calls.
3. Run `ark test <run>` (full), then `ark merge-request open <run>`. Read the exit code and the body of the new `gh pr edit` call.

## Expected results

- Step 1: exit 0; the created body holds `Full suite: CI (no code file in this diff)`.
- Step 2: exit 1. stderr holds ``the last test at this head is quick, not a gate: run `ark test <run>` ``. The remote branch tip is the tip of step 1, no `gh pr edit` call is recorded, and no second `merge_request.opened` event is written.
- Step 3: exit 0; one `gh pr edit` call; its body has no `Full suite:` line and has the `- Tests: <n> passed` line of the full run; the remote branch tip is the head with `src/a.ts`.

## Screenshot checkpoints

none: CLI, git and MR-body text case; no UI surface.
