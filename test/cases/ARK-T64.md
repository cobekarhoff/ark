---
id: ARK-T64
title: ARK-T64 ark run start warns once for a bug or refactor ticket with no method test AC
level: integration
technique: equivalence classes on ticket kind (bug, refactor, feature) crossed with AC methods (no test AC, one test AC), plus a boundary on zero ACs
priority: medium
risk: the warning is missing, repeated, worded differently from the ticket, written to stdout where it breaks scripts that parse the run id, shown for a feature ticket or a ticket with a test AC, or it makes ark run start refuse
status: active
changed_by: 2026-11-07-ARK-351-1
---

## Objective

Prove that `ark run start` warns once, without refusing, when a `kind: bug` or `kind: refactor` ticket has no `method: test` AC, and does not warn otherwise. Serves ARK-351/AC3.

Expected: When a bug or refactor ticket has no `method: test` AC, the system shall print `warning: kind <kind> has no method: test AC, so its red-test or base-pass rule does not apply` once and start the run.

## Preconditions

- A temporary `ARK_HOME` and project with a git repo.
- Tickets: T1 `kind: bug`, three `inspection` ACs; T2 `kind: refactor`, one `inspection` and one `analysis` AC; T3 `kind: feature`, only `inspection` ACs; T4 `kind: bug`, one `method: test` and one `inspection` AC; T5 `kind: refactor`, one `method: test` AC; T6 `kind: bug` with zero ACs.

## Steps

1. Start each ticket T1 to T6 once, each in its own fresh temporary `ARK_HOME` and project (the product refuses a second start of a ticket with an open run, so never start a ticket twice). Run `ark run start <ticket> >out.txt 2>err.txt` and read the exit code, `out.txt` and `err.txt`.
2. For T1 only, read `out.txt` as the value a script gets from `RUN=$(ark run start <ticket> 2>/dev/null)`; this reuses the step 1 start and needs no second start.

## Expected results

- T1: stderr has exactly one line `warning: kind bug has no method: test AC, so its red-test or base-pass rule does not apply`; the run starts; exit code 0.
- T2: stderr has exactly one line `warning: kind refactor has no method: test AC, so its red-test or base-pass rule does not apply`; the run starts; exit code 0.
- T3: no `warning:` line; the run starts.
- T4 and T5: no `warning:` line; the run starts.
- T6: one warning line for kind bug; the run starts.
- `out.txt` of every start holds only the run id. In step 2, the T1 value is the run id alone, with no `warning:` text.

## Screenshot checkpoints

None. The surface is CLI output; the mockup `mockups/S1-run-start-warning.md` shows the text and no screenshot applies.
