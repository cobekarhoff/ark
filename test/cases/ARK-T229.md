---
id: ARK-T229
title: ARK-T229 The `--verified-by` amend refuses a test case id with no active file, and changes nothing
level: integration
technique: equivalence classes of the id (file at HEAD, no file, retired file at HEAD, file at HEAD of another repo's worktree, file only in the working tree or untracked, malformed id) and an empty list
priority: high
risk: a typo, an uncommitted id or an unmerged id enters ticket.md (a filesystem-existence check passes a case that HEAD does not hold), so the criterion has proof that no case file backs and `ark test` reports it missing at the MR gate; a retired case is accepted as proof
status: active
changed_by: 2026-11-10-ARK-361-1
---

## Objective

Prove that the amend checks every id against the case files at the head of the run's worktrees before it writes anything. Serves ARK-361/AC2.

Expected: If any id in `--verified-by` has no active `test/cases/<id>.md` in the workspace, then the system shall refuse the amend, name the id, append no event and leave ticket.md unchanged.

## Preconditions

- A temporary `ARK_HOME`, project and git repo; a run in building with AC1 `verified_by: [ARK-T1]`.
- `test/cases/ARK-T1.md` and `ARK-T2.md` active; `ARK-T3.md` with `status: retired`; no file for `ARK-T9`; all committed in the run's worktree.
- A second repo worktree in the workspace holding an active `ARK-T5.md`, committed there (multi-repo run).
- `ARK-T7.md` active but only in the working tree: one copy untracked, one `ARK-T8.md` staged but not committed.

## Steps

1. Run the amend with `--verified-by ARK-T1,ARK-T9`.
2. Run it with `ARK-T3` (retired).
3. Run it with `ARK-T2,ARK-T5` (file only in the second repo).
4. Run it with `ARK-T7`, then with `ARK-T8`.
5. Run it with an empty value, and with `ARK-T2,,ARK-T1`.
6. After each refusal, read ticket.md and the event log.

## Expected results

- Steps 1 and 2 exit non-zero, name the offending id (`ARK-T9`, `ARK-T3`), and add no `criteria.amended` event; ticket.md is byte-identical.
- Step 3 succeeds (the id is committed in any repo worktree).
- Step 4 exits non-zero naming `ARK-T7`, then `ARK-T8`: a case file not at HEAD is not proof; no event, ticket.md byte-identical. Committing the file and repeating the call then succeeds.
- Step 5 is refused with a clear message naming the empty entry; nothing changes.

## Screenshot checkpoints

none: CLI and file assertions only
