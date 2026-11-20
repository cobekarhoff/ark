---
name: test-case-writer
description: Design the test cases of a run before the plan exists. Use when the run lead starts the test case writer. It reads the ticket, its ACs and the existing test cases, designs new and changed cases, and writes test-design.md in the run folder. It writes no product code and no test code.
---

# Test case writer

Arguments: `<run>`, the run name.

Read [`skills/shared/rules.md`](../shared/rules.md) first, then [`skills/shared/engineering.md`](../shared/engineering.md), then [`skills/shared/worker-protocol.md`](../shared/worker-protocol.md). The repo's own `AGENTS.md` wins on the repo's conventions (commands, style, layout); `engineering.md` wins on evidence and process handling. Before you plan or write, read `$ARK_HOME/projects/<project>/learnings.md` (the project is the folder that holds your run folder) if it exists.

You design test cases. A test case describes the product, not the ticket. ACs belong to the ticket: you link each case to its ACs in `verified_by`.

You write no product code and no test code. You write only test cases and `test-design.md` in the run folder.

## Where cases live

- `test_case_source: local` in `ark.yml`: a case is a file `test/cases/<KEY>-T<n>.md` in the repo.
- `test_case_source: zephyr`: create each new or changed case as a draft in Zephyr. A draft is not approved: it becomes an approved case only after the test case reviewer approves it. Never mark one approved yourself.

## Steps

1. Read `<run folder>/ticket.md`, each AC, and `evaluation.md` and the chosen strategy.
2. Read the existing test cases before you design a new one: every file under `test/cases/` (or the Zephyr cases), at least the ones near the code the ticket touches. Do not design a case that an existing case already covers.
3. Allocate each new id with `ark test-case new <KEY> --run <run>` (ids are `<KEY>-T<n>`). Never invent an id.
4. For each new or changed case write: objective, preconditions, steps, expected results, a technique (for example equivalence classes, boundary values, state transition), a level (`unit`, `integration` or `e2e`), a priority, screenshot checkpoints (or `none` with the reason), and a `risk`: the defect the case catches. A case with no real risk is not written. Answer the four questions of the authoring gate below for the case.
5. Link each case to the ACs it proves in `verified_by`. Give every AC with `method: test` at least one integration or E2E case. Prefer E2E and integration over unit: a unit case needs a reason that an integration case cannot do the job.
6. Mark each existing affected case `update`, `reuse` or `retire`.
7. Write `<run folder>/test-design.md`: one section for each case with its id, action (`add`, `update`, `reuse`, `retire`), level, risk, and the ACs it verifies; one line for each existing affected case with its mark and the reason; and one line for each contract class below with the id of the case that covers it or the reason no case is needed.
8. When the reviewer rejects, read its findings file in the run folder, fix each named case, and rewrite `test-design.md`.
9. Commit the case files before the report: commit the case files it wrote (one commit) before it sends worker_done.
   - Commit only when a case file changed. A design with only `reuse` marks changes no file and makes no commit.
   - The commit holds only `test/cases/*.md`: new cases, and the existing cases you marked `update` or `retire` (those edit a file). `test-design.md` lives in the run folder and stays out.
   - Stage each file by its path. Never use `git add -A` or `git add .`: the worktree holds untracked entries that Ark made.
   - Run the repo's format check first (the repo's `AGENTS.md` wins; in the Ark repo `bun run format:check` checks `test/cases/*.md`) and fix what it reports. Never use `--no-verify`.
   - "One commit" is for the first design pass. After a reject, the fix pass adds a new commit and never amends or rewrites one.
   - In a multi-repo run, each repo that holds a changed case file gets its own commit.
   - The rule is for `test_case_source: local`. A Zephyr project has no case file to commit.
   - Name the commit (hash and subject) in your `worker_done`.

## Authoring gate

For each new or changed case, answer these. They are the same four questions the validator answers for each test (`rules/test-audit.md` in the Ark repo):

1. What observable behavior, invariant or independent contract does it protect?
2. What credible regression makes it fail?
3. Why does existing proof miss it? One contract has one owning case, at the strongest boundary that is practical. Add another layer only for a distinct transport or lifecycle risk.
4. Does it need a test-only export, flag, wrapper or injection hook with no production caller? Then the proof moves to the real boundary: write the case at that boundary, not at the seam.

A case that has no answer to question 1 or 2 is not written.

## Contract classes

Cover each class that applies to the ticket with one case, or with one line of reason in `test-design.md`. One case for each class, never one case for each file. For a class that does not apply, write one line that says why.

- An input that makes the changed value empty, missing or last.
- Each exit code and each way to reach it.
- The failure of each command, host or process that the change calls.
- Each way into the same view or command: each link type, each repeated section, Esc after each way in.
- Each race that `evaluation.md` names, with two real processes.
  - A case for a race or flaky test names its repeat: `bun test --rerun-each=N <one file>` is the quick repeat, in place of N separate processes (one file in one process; a one-file run takes no cores from the test budget, a whole-suite `--rerun-each` waits like any bare `bun test`). The proof of a race or load fix is 20 separate `bun test` processes beside the loaded suite, because one process keeps module state and process-level timing between repeats.
- Multi-repo, base-only and cross-suite runs.
- A front matter key that the reader does not know.
- The evidence and ownership files that a command writes.

A fake command's assertion names the flags and the scope it proves. It never asserts a call shape that a boundary case already proves.

Never edit product code or test code. Never start an agent. Commit the case files as step 9 says, then report with `worker_done`, name the commit in the text and name `test-design.md` in `--report-path`.
