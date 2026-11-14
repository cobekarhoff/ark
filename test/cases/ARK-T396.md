---
id: ARK-T396
title: ARK-T396 the reader names every AC as ticket slash AC number, reads each method, and ark test lists non-test methods through the manual gate with both id forms
level: integration
technique: "equivalence classes over the AC method (test, manual true, analysis, inspection, demonstration) and over the id form (local, old ticket-ACk, new ticket/ACk), with state transition pending -> ok or problem on the manual answer"
priority: high
risk: "an AC id keeps its local or old form so a criterion has two names; a non-test method is read as a test and `ark test` demands a test case of it, or is dropped and passes with no answer; `gate record manual` takes only one id form; or a test AC is accepted as manual"
status: active
changed_by: 2026-11-13-ARK-332-1
---

## Objective

Prove that `ark run start` records every AC of a ticket as `<ticket>/AC<k>` whatever form the ticket writes, and that `ark test` lists each AC by its method: test ACs as `missing` until a case runs, the other methods as `manual pending` until the human answers, with the answer accepted in the local, old and new id forms and refused for a test AC.

## Preconditions

- A temp ARK_HOME with a project `methods`: a valid config with one e2e suite (`true {report}`).
- A ticket `ARK-910` with 6 ACs: `AC1` (local id, `verified_by` `ARK-T1`), `ARK-910-AC2` (old id, `manual: true`), `AC3` (method analysis), `ARK-910/AC4` (new id, method inspection), `AC5` (method demonstration), `AC6` (method `test` written out, `verified_by` `ARK-T1`).
- A run started from it, an evaluation recorded, and a plan with one build step that carries the 6 criteria and the test case `ARK-T1` (add, e2e). The plan checked, the plan gate approved, and a worktree created.
- Real `ark` as a child process.

## Steps

1. Run `ark run start` on the ticket. Read the criteria of the first event.
2. Run `ark test <run>`.
3. Record the manual answers: `gate record manual ARK-910-AC2 ok`, `AC3 problem`, `ARK-910/AC4 ok`.
4. Run `ark test <run>` again.
5. Run `gate record manual ARK-910-AC1 ok`.

## Expected results

- When the run starts, the first event shall carry the criteria `ARK-910/AC1` to `ARK-910/AC6`, in the new form, in ticket order.
- When `ark test` runs before any answer, it shall exit 1, list `ARK-910/AC1` and `ARK-910/AC6` as `missing`, and list `AC2`, `AC3`, `AC4` and `AC5` as `manual pending`.
- The old form, the local form and the new form shall each be accepted for the same AC (step 3 exits 0 in each).
- When `ark test` runs again, it shall list `AC2` as `manual ok`, `AC3` as `manual problem`, `AC4` as `manual ok` and `AC5` as `manual pending`.
- When a manual answer names a test AC (`ARK-910-AC1`), the system shall exit 1 and say `ARK-910/AC1 is not manual`.

## Screenshot checkpoints

none: a CLI case, no screen.
