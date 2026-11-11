---
id: ARK-T228
title: ARK-T228 `ark criteria amend --verified-by` replaces the list in ticket.md and records the old list, new list and reason
level: integration
technique: equivalence classes on the frontmatter form of verified_by (inline list, block list, `[] # comment`, absent) and state transition (building, plan before and after approval)
priority: high
risk: the amend rewrites the wrong line, loses or corrupts the criterion text, method or other criteria, drops the old list from the event, or, when it adds the key to an absent-key criterion, leaves the criterion in legacy proof mode so the new ids are ignored
status: active
changed_by: 2026-11-10-ARK-361-1
---

## Objective

Prove that the second form of `ark criteria amend` replaces only the `verified_by` list of one criterion and records the change. Serves ARK-361/AC1.

Expected: When the human runs `ark criteria amend <run> <criterion id> --verified-by <ids> --reason <text>` with existing active case ids, the system shall replace the verified_by list of that criterion in the run's ticket.md and record criteria.amended with the old list, the new list and the reason, and the text and method of the criterion shall not change.

## Preconditions

- A temporary `ARK_HOME`, project and git repo, as in `test/criteria-amend.test.ts`.
- Active files `test/cases/<id>.md` for the old ids and the new ids, committed at the HEAD of the run's worktree.
- Four runs in building, one for each frontmatter form of `verified_by` on AC1: inline `[ARK-T1]`, block list, `[]   # comment`, absent.
- A criterion AC2 beside AC1 with its own list, text and `method: test`.

## Steps

1. For each run, run `ark criteria amend <run> AC1 --verified-by ARK-T300,ARK-T301 --reason "renumbered"`.
2. Read ticket.md and the last `criteria.amended` event of each run.
3. In the absent-key run, read the criterion proof mode before and after (`newScheme`).

## Expected results

- Exit 0; output names AC1 and the old and new lists.
- ticket.md: AC1 `verified_by` is exactly `[ARK-T300, ARK-T301]` in every form; the AC1 text, method, the table rows, AC2 and the rest of the file are byte-identical.
- The event has `criterion: AC1`, `verified_by_old` (the previous list, `[]` when absent), `verified_by_new`, the reason and no text fields.
- Adding a nonempty `verified_by` to the absent-key local-id criterion makes it case-based (`newScheme` true, as `cli/ticket.ts` defines it by the presence of `verified_by` or a local id), so the new ids are the proof; its text stays byte-identical.

## Screenshot checkpoints

none: CLI and file assertions only
