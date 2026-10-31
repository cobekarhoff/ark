# Run a ticket from Master Chief to a merged PR

This page shows you how to take one ticket to a merged PR with Ark. You talk to Master Chief. It starts a run lead for the ticket, the run lead plans and builds the change, and you decide at the gates and merge on your git host.

## Before you start

- Bootstrap the project once with `/skill:ark bootstrap`. This writes `~/.ark/projects/<project>/ark.yml`.
- In Orca, set Settings → Orchestration → Nested worker depth to 2. Ark needs this so Master Chief can start run leads and run leads can start workers.
- Install the `ark` command, and sign in to `gh` for GitHub or `glab` for GitLab.
- Install Plannotator if you want to review the plan in a browser. Without it, you review the plan in the Master Chief session.

## 1. Open Master Chief in an Orca terminal

1. In Orca, open a terminal in the project's workspace.
2. Start your agent in that terminal.
3. Run:

   ```text
   /skill:ark chief
   ```

Master Chief must run inside an Orca terminal. If it does not, it stops and tells you why. Open the agent from an Orca terminal and run the command again.

## 2. Name the ticket

Tell Master Chief which ticket to run. It reads the ticket from the project's ticket source and tells you:

- whether each AC is testable,
- which repos the ticket likely changes,
- what it depends on or what is unclear.

Master Chief then suggests related tickets: blockers, tickets blocked by this one, and tickets that touch the same repos. Choose which to queue. Master Chief queues only the tickets you approve, and it keeps their dependencies.

## 3. Let the run start

Master Chief starts a run for each ticket that is ready, up to the `concurrency` set in `ark.yml`. For each one it saves the ticket, runs `ark run start`, and starts a run lead.

To see where a run is at any time, run:

```sh
ark status
ark status <run>
```

`ark status` lists every open run. `ark status <run>` shows the phase, the round, the current step, the gate that waits for you, the MR links and the cost so far.

## 4. Answer the gates

The run lead asks for your decision at a gate. Master Chief shows you each question and sends your answer back. You answer only in Master Chief's session or in Plannotator.

**Criteria gate.** This opens only when the ticket has no testable AC. The run lead proposes AC. Accept them, edit them, or abort the run.

**Plan gate.** This opens before any code is written. The run lead shows you `plan.md`: a summary, a table of changes, a diagram of the steps, and the test cases.

1. If Plannotator opens, read the plan there. Approve it, or annotate what to change and submit. Annotated feedback sends the plan back for changes.
2. If it is shown in Master Chief's session, answer `approve`, `change` or `abort`.
3. You can edit `plan.yml` yourself. The run lead checks the file again with `ark plan check` and asks you again.

Check that every AC has an integration or E2E test case. Unit tests never prove an AC. Check that each repo the ticket touches has a step. Check which model reviews each step. By default, the reviewer is a different vendor from the implementer.

**Escalation gate.** This opens when the run spends its round budget, which defaults to two rounds. The run lead shows what still fails. Choose one of:

| Answer           | What happens                                                                            |
| ---------------- | --------------------------------------------------------------------------------------- |
| `one_more_round` | The budget grows by one round.                                                          |
| `take_over`      | You write the change yourself in the run's worktree. Tell the run lead when you finish. |
| `abort`          | The run stops before any MR is opened.                                                  |

## 5. Wait for the build

After you approve the plan, the run lead creates the run's worktrees with `ark worktree create`. Workers then build the change: an implementer writes the code, a validator writes the tests that prove each AC, and a reviewer looks for defects.

The run lead runs `ark test` on the composed workspace. A criterion is proven only when its tagged integration or E2E test passes. The run lead decides which review findings send work back to the implementer, and it says why. It opens the MRs only when the tests pass at the latest commit.

You do not need to do anything in this phase except answer gates.

## 6. Review and merge the PRs

When the run lead opens the MRs with `ark merge-request open`, Master Chief gives you a link for each. For a ticket that changes several repos, there is one PR for each repo, listed in the order to merge them.

1. Review each PR on your git host. Ask for changes there if you need them.
2. Merge the PRs in the order listed. Each later PR says which one it depends on.
3. Tell Master Chief that you merged them.

No Ark command merges. Only you merge.

## 7. Close the run

Master Chief checks the state of each PR with `gh` or `glab`, and then closes the run with `ark run close <run> <outcome>`:

| What happened                             | Outcome      |
| ----------------------------------------- | ------------ |
| You merged every PR                       | `merged`     |
| You closed the PRs without merging        | `abandoned`  |
| You took the branches and want no PRs     | `handed_off` |
| You stopped the run before any PR existed | `aborted`    |

## 8. Answer the retro questions

The run lead writes `retro.md` for the run, on top of the numbers from `ark retro`. After the run closes, Master Chief asks you three questions: what caused the most pain, what to change now, and what surprised you. It records your answers in `retro.md`.

Any change that follows from a retro takes effect only after you approve it.

## If something goes wrong

- **Master Chief refuses to start.** The session is not in an Orca terminal. Open it from one.
- **A run lead cannot start a worker.** Orca's nested worker depth is below 2. Set it to 2 in Orca's settings.
- **You want to stop a run.** Tell Master Chief to abort it. An abort at any gate closes the run with the outcome `aborted`.
- **A bug turns up after you merge.** Give Master Chief the bug ticket and say which run caused it. It links the two as an escaped defect.
