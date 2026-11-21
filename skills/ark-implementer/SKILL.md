---
name: ark-implementer
description: Write the product code of one plan step. Use when the run lead starts an implementer step with /skill:ark-implementer <run> <step>; it commits on the step's branch and writes no integration tests.
---

# Ark implementer

Arguments: `<run> <step>`.

Read [`skills/shared/rules.md`](../shared/rules.md) first, then [`skills/shared/engineering.md`](../shared/engineering.md), then [`skills/shared/worker-protocol.md`](../shared/worker-protocol.md). The repo's own `AGENTS.md` wins on the repo's conventions (commands, style, layout); `engineering.md` wins on evidence and process handling. Before you plan or write, read `$ARK_HOME/projects/<project>/learnings.md` (the project is the folder that holds your run folder) if it exists.

You write the product code.

1. Implement the change the step's AC describe, in this repo only. Keep the change as small as the AC allow. Read [`skills/shared/principles.md`](../shared/principles.md) in the Ark repo first.
2. Use the repo's own checks while you work: its build and unit tests. Unit tests are for you. They count as proof of an AC only as a `verified_by` test case.
3. Before each commit and before `worker_done`, run the check commands that the repo's `AGENTS.md` names, and each `checks` entry of the project's `ark.yml` (`$ARK_HOME/projects/<project>/ark.yml`, found as `learnings.md` is) whose `repo` is this step's repo. Run a command that writes files (a formatter) first, then the read-only ones. `ark test` runs the `checks` entries too, so a failure of one shows twice. Run them in rework rounds too, and for Markdown-only changes. Fix every failure first. Commit the files the formatter changed.
4. If a findings file or a failing test list names your step (a rework round), fix exactly what it lists. The file is `<run folder>/findings/round-<round>.md`. Do not widen the change.
5. Commit your own work on the branch `ark/<ticket id>-<slug>` before `worker_done`. Do not leave it uncommitted for the reviewer or the run lead. `ark test` runs on the latest commit, so uncommitted work counts for nothing. Do not push, and do not open an MR. `ark merge-request open` does that.
6. Do not write the integration or E2E tests of the plan's test cases. The validator writes them. Conversion on touch: a test that has an old AC id in its title keeps proving that one AC until a run changes it. When your diff touches such a test, write a test case with `ark test-case new <KEY> --run <run>`, rename the test title to start with the test case ID, and make sure the plan names the case. If it does not, say so in your report. The reviewer rejects a diff that touches such a test and leaves its title unchanged.
