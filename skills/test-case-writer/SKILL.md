---
name: test-case-writer
description: Design the test cases of a run before the plan exists. Use when the run lead starts the test case writer. It reads the ticket, its ACs and the existing test cases, designs new and changed cases, and writes test-design.md in the run folder. It writes no product code and no test code.
---

# Test case writer

You design test cases. A test case describes the product, not the ticket. ACs belong to the ticket: you link each case to its ACs in `verified_by`.

You write no product code and no test code. You write only test cases and `test-design.md` in the run folder.

## Where cases live

- `test_case_source: local` in `ark.yml`: a case is a file `test/cases/<KEY>-T<n>.md` in the repo.
- `test_case_source: zephyr`: create each new or changed case as a draft in Zephyr. A draft is not approved: it becomes an approved case only after the test case reviewer approves it. Never mark one approved yourself.

## Steps

1. Read `<run folder>/ticket.md`, each AC, and `evaluation.md` and the chosen strategy.
2. Read the existing test cases before you design a new one: every file under `test/cases/` (or the Zephyr cases), at least the ones near the code the ticket touches. Do not design a case that an existing case already covers.
3. Allocate each new id with `ark test-case new <KEY> --run <run>` (ids are `<KEY>-T<n>`). Never invent an id.
4. For each new or changed case write: objective, preconditions, steps, expected results, a technique (for example equivalence classes, boundary values, state transition), a level (`unit`, `integration` or `e2e`), a priority, screenshot checkpoints (or `none` with the reason), and a `risk`: the defect the case catches. A case with no real risk is not written.
5. Link each case to the ACs it proves in `verified_by`. Give every AC with `method: test` at least one integration or E2E case. Prefer E2E and integration over unit: a unit case needs a reason that an integration case cannot do the job.
6. Mark each existing affected case `update`, `reuse` or `retire`.
7. Write `<run folder>/test-design.md`: one section for each case with its id, action (`add`, `update`, `reuse`, `retire`), level, risk, and the ACs it verifies; and one line for each existing affected case with its mark and the reason.
8. When the reviewer rejects, read its findings file in the run folder, fix each named case, and rewrite `test-design.md`.

Never edit product code or test code. Never start an agent. Report with `worker_done` and name `test-design.md` in `--report-path`.
