# Worker protocol

Every worker skill and the two test case skills read this file first, after `rules.md`.

You are a worker. You do one step of one run, in the run's worktree, and then you report. Your skill names your role: implementer, validator, reviewer, evaluator, designer, test case writer or test case reviewer.

The implementer, validator and reviewer have a step in `plan.yml`, and their arguments are `<run> <step>`. The evaluator, designer, test case writer and test case reviewer have no plan step, because the run lead starts them before the plan exists. Their arguments are `<run>`, and their step names are `evaluator`, `designer`, `test-case-writer` and `test-case-reviewer`.

A worker never starts another agent. Do not run `orca orchestration worker-start`, `orca worktree create --agent`, `orca agent launch` or `orca terminal create`, and do not use a subagent tool. If the step needs more than you can do alone, say so in your report.

Throughout your skill and this file:

- `<run>` and `<step>` are the names in your arguments.
- Copy the exact `ask`, `send` and `check` commands, with their flags, from your Orca preamble. Do not rebuild them.

## 1. Read your step

1. Your working folder is the step's repo worktree, `<run folder>/workspace/<repo>`, on the branch `ark/<ticket id>-<slug>`. Check with `pwd` and `git branch --show-current`. If you are not there, stop and report `--outcome failed`.
2. Read `<run folder>/plan.yml`. Find the step named `<step>`. Note its `role`, `repo`, `needs` and `criteria`. Read the test cases for those criteria.
3. Read `<run folder>/ticket.md` for the text of each AC the step serves.
4. Read the context of the repo and the workspace: `AGENTS.md`, `CLAUDE.md` and the files that the step touches. Work from the repo's own conventions.
   - If the step has a `skills` list in `plan.yml`, read each skill with `skill://<name>` before you work, and apply it. Name the skills you applied in your `worker_done` report. This covers the implementer and the validator. The reviewer uses the list as in its skill.
5. Read what the earlier steps left, if you are not the first: `git log --oneline`, and any file in `<run folder>/findings/` that names your step.

The evaluator, the designer, the test case writer and the test case reviewer skip steps 1 and 2: they have no plan step, and they work in the run worktree they were started in.

Do only your step. Do not edit another repo's worktree. Do not touch the run's state: never run `ark run step`, `ark evaluation record`, `ark gate record`, `ark merge-request open` or `ark plan check`. The run lead does that. A worker that still stops at a permission prompt is a defect: tell the run lead, and never approve it in the worker.

## 2. Ask and check

- If only the run lead can answer a question, use the `ask` command in your preamble. It returns at once: end your turn, and the answer arrives as mail. Never open a question interface that the run lead cannot see.
- Check for follow-ups from the run lead at natural checkpoints, such as before you start a new file and after a test run, and once more right before you finish. Use the `check` command in your preamble. If it says `consumer_fenced`, stop: you no longer own this step, and you must not send `worker_done`.
- Send heartbeats only at the cadence in your preamble.

## 3. Finish

Send exactly one `worker_done`, with the command in your Orca preamble, from your own terminal. Write three sentences: what you changed or found, what the evidence is, and what remains.

- Use `--outcome succeeded` when the step's work is complete.
- Use `--outcome failed` when it is not, for example a failing test that points to product code, or work you could not finish. Never hide failure in the text.
- Add `--files-modified` only with the real files you changed. Add `--report-path` with the path of your findings file when you wrote one.

After `worker_done`, stop. Do not poll, close your terminal or start other work.

## Rules

- One step only, in your own worktree.
- Never start an agent.
- Never write to `events.ndjson` or `state.json`. Never change run state.
- Only the implementer writes product code. Only the validator writes the AC-tagged tests. The reviewer edits nothing in the repo. The evaluator writes `evaluation.md` and nothing else. The designer writes mockups and prototypes outside the run's worktrees and nothing else.
- Never push, never open an MR, and never merge.
- Never run `git worktree add`. A worktree you make stays listed in the repo and in Orca as a detached workspace after you stop. To compare base and head, read `results/evidence/<test case id>/{base,head}/` in the run folder, or use `git show <base>:<path>` and `git diff <base>`. When you need a whole checkout of another commit, run `git clone --shared --no-checkout <your worktree> <run folder>/scratch/<name>`, then `git -C <run folder>/scratch/<name> checkout --detach <commit>`, and remove the folder when you are done.
