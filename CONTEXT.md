# Ark

Ark takes a ticket to merge-ready changes in one repo or across several dependent repos. You talk to one agent session, Master Chief. It starts a run lead for each ticket; the run lead plans the work and starts workers to build, test and review it. You decide at the gates and you merge.

## Start with these

| Term                   | In one line                                               |
| ---------------------- | --------------------------------------------------------- |
| **Ticket**             | The requested work, with acceptance criteria.             |
| **Run**                | One attempt to take one ticket to a closed outcome.       |
| **Master Chief**       | The one agent session you talk to.                        |
| **Run lead**           | The agent that owns one ticket and plans its run.         |
| **Gate**               | A point where the run waits for your decision.            |
| **Merge request (MR)** | What Ark opens for you to review and merge, one per repo. |

## Work

**Ticket**:
A piece of requested work with acceptance criteria, from the project's ticket source.
_Avoid_: Issue, story, task

**Acceptance criterion (AC)**:
One testable statement of what a ticket must achieve. It is local to its ticket: the ticket writes `AC1`, and another ticket names it `ARK-243/AC1`. The old form `ARK-243-AC1` is the same AC. A done ticket's ACs never change. Each has a `method` and a `verified_by` list of test cases (ADR 0010).
_Avoid_: Requirement, condition

**Test case**:
One lasting statement of what the product does, in `test/cases/<KEY>-T<n>.md`. Its ID starts the title of the test that runs it. An AC links to its test cases through `verified_by`, many to many (ADR 0010).
_Avoid_: Test, scenario

**Kind**:
A ticket field: `feature` (the default), `bug`, `perf` or `refactor`. It changes what `ark test` and `ark merge-request open` require.
_Avoid_: Type, category

**Evidence**:
What shows that an AC holds, kept in the run folder under `results/evidence/`: for each `verified_by` test case, a `base/` and a `head/` folder with `result.json`, `command.log` and any `screenshots/` from the base and head runs of `ark test`; for a method other than `test`, one file `<AC id>.md` in the shape of its method plus the human's `manual` gate answer. A manual AC may also commit its evidence file under `docs/evidence/`.
_Avoid_: Proof file, report

**Run**:
One attempt to take a ticket from start to a closed outcome. A ticket can have several runs over time, but only one open at once.
_Avoid_: Attempt, session, job

**Run folder**:
The directory `$ARK_HOME/projects/<project>/runs/<run>/`. It holds `events.ndjson`, `state.json`, the plan, the results, the findings and `retro.md`.
_Avoid_: Run directory

**Outcome**:
How a closed run ended: merged, abandoned, aborted or handed off.
_Avoid_: Result, status

**Merged**:
Every MR of the run was merged on the git host, by a human or by the auto-merger (`ark services install`). Ark's agents and the `ark` command never merge.
_Avoid_: Done, shipped

**Abandoned**:
The run's MRs were opened, then closed unmerged by a human.
_Avoid_: Rejected, cancelled

**Aborted**:
The run stopped before any MR was opened.
_Avoid_: Cancelled, failed

**Handed off**:
The run's tests passed and its branches were given to a human without Ark opening MRs. Each branch with commits beyond its base stays in its clone; the worktrees are removed.
_Avoid_: Delivered

**Hub**:
The browser page `ark ui` serves, from `hub/`. Home shows what needs the human, then each open run with its agents, models, MRs and cost; Run shows any run, open or closed, with its plan DAG, decisions, run files and agent transcripts; Runs lists every run on one board with a cross-run dependency graph; Roadmap shows the vision, the milestones and the ranked tickets with their runs, and a ticket opens as a full page. It is a view. Its one action is "Open in Orca", which focuses a live agent's terminal in Orca (live = Orca lists the terminal as connected; an agent session Orca lists only as a worker shows "running in Orca, open it from its chat tab", a released one "ended, not in Orca"). It steers no agent, sends no text and changes no run state (ADR 0009).
The project filter is site-wide: the `project` query of the hash, with "All projects" (no query) the default; the header's Project group sets it, and every link keeps it.
_Avoid_: Control center, dashboard

**Merge request (MR)**:
The request Ark opens for a human to review and merge one repo's changes. On GitHub it's a pull request. Its title is `<ticket id>: <summary>` and its body comes from the run (the pr-writing core); `ark merge-request open` refreshes the body after a new head.
_Avoid_: Change request

**Roadmap**:
The file `$ARK_HOME/projects/<project>/ROADMAP.md`: the vision, the milestones and the human's rank of the open tickets. Only the human changes a rank. Format: `docs/reference/roadmap.md`.
_Avoid_: Backlog table, plan

**Milestone**:
A named outcome in the roadmap, such as M9 "See the work". It is `done`, `active` or `later`. A ticket joins one by its `milestone:` field.
_Avoid_: Release, epic

**Horizon**:
Now, Next or Later: one of the three ranked lists of the roadmap. An open ticket in no horizon is Unranked.
_Avoid_: Priority, sprint

## Roles

**Master Chief**:
The one agent session you talk to. It suggests and queues tickets, starts a run lead for each, and brings you every gate. It never writes product code.
_Avoid_: Orchestrator, main agent, coordinator, master agent

**Brainstorm partner**:
The agent session you open to explore ideas. It writes the ideas you keep as proposed tickets. It never sets a ticket to ready, queues one, or sends to Master Chief.
_Avoid_: PO agent

**Run lead**:
The agent that drives one run across every repo its ticket touches. It plans, starts workers, decides what to do with findings, and asks you for gate decisions through Master Chief. It never writes product code.
_Avoid_: Orchestrator, ticket lead, lead

**Worker**:
An agent a run lead starts for one step. There are seven roles: implementer, validator, reviewer, evaluator, designer, test case writer and test case reviewer. The run lead starts one evaluator before it plans, and one designer when the ticket changes something a person sees, unless the surface is only `none`, or there is one card and the surface is only `document`, `cli_output` or `none`. It starts the test case writer and test case reviewer after the strategy and before `plan.yml`. A worker never starts other agents.
_Avoid_: Subagent, child agent, helper

**Implementer**:
The worker that writes product code in one repo. You can take over this role at an escalation.
_Avoid_: Coder, developer, builder

**Validator**:
The worker that turns the plan's test cases into tagged integration and E2E tests and makes them pass.
_Avoid_: Tester, QA agent

**Reviewer**:
The worker that looks for defects in a run's changes and reports findings. It never edits.
_Avoid_: Critic, judge, auditor

**Evaluator**:
The worker that checks a ticket before the run lead plans. It reads the ticket and the code, runs read-only probes, and writes `evaluation.md` with blockers and risks. It never edits product code. `ark.yml` sets its harness and model.
_Avoid_: Pre-reviewer, triage agent

**Designer**:
The worker that makes mockups for the strategy cards, and for a question about interaction a running prototype in a throwaway worktree. It revises them in each design round and never edits product code. Mockups never go into an MR. `roles.designer` in `ark.yml` sets its harness and model, and it is optional: it is not needed when the surface is only `none`, or when there is one card and the surface is only `document`, `cli_output` or `none`.
_Avoid_: UI agent, artist

**Test case writer**:
The worker the run lead starts after the strategy and before it writes `plan.yml`. It writes the run's test cases and never test code or product code. `roles.test_writer` in `ark.yml` sets its harness and model.
_Avoid_: Test designer

**Test case reviewer**:
The worker that approves or rejects the test cases, from a different vendor than the writer by default, and checks the diff after the validator step. No implementer starts before it approves. `roles.test_reviewer` in `ark.yml` sets its harness and model.
_Avoid_: QA reviewer

**Strategy**:
A whole way to do the ticket, written as a short card in `strategies.md`: approach, interfaces, tradeoffs, rough steps, optional mockup links and a recommendation. With one possible strategy, the file has one card and a reason.
_Avoid_: Option, proposal

**Strategy gate**:
The gate that opens when `strategies.md` has 2 or more cards. The phase is `awaiting_strategy`. You answer with a card ID or abort. With one card, no gate opens.

**Design round**:
One more `ark strategy record` before you answer the strategy gate, after you annotated the cards or mockups and the same Designer revised them. Design rounds have no budget and never open an escalation.
_Avoid_: Strategy round

**Decision**:
A smaller choice inside the chosen strategy, in the `decisions` list of `plan.yml`: a question, 2 to 4 options with tradeoffs, a recommended option and, after you answer, the chosen one. You answer open decisions at the plan gate, and `plan approve` is refused while one is open.
_Avoid_: Question, open point

**Blocker**:
A problem the evaluator finds in an AC: it is not possible, no integration or E2E test case can prove it (a criterion with a method other than `test` is exempt), or it conflicts with other code. A blocker opens the criteria gate.

**Risk**:
A problem the evaluator finds that the plan must handle. `plan.md` lists each risk.

**Vendor**:
The company whose model runs a worker, such as Anthropic or OpenAI.
_Avoid_: Provider, model family

**Cross-vendor review**:
The default that reviewers use a different vendor from the implementers. The plan sets it per step, and you can change it at the plan gate.
_Avoid_: Vendor rule

## Planning and proof

**Plan**:
A run's graph of steps and its test cases, written by the run lead. You review, edit and approve it at the plan gate before any code is written.
_Avoid_: Task list, workflow, pipeline

**Step**:
One piece of a plan: one role's work in one repo, the steps it waits for, and the ACs it serves.
_Avoid_: Task, node, job, stage

**Proof**:
What lets an AC count as met. For `method: test`, every test case in its `verified_by` passes at head in the last `ark test`. For another method, its evidence file exists and you answered `manual ok`. `ark merge-request open` refuses until every AC is met (ADR 0010).
_Avoid_: Verification

**Finding**:
A defect a reviewer reports, ranked from P0 (must fix) to P3 (minor).
_Avoid_: Issue, comment, bug report

## Gates and rework

**Gate**:
A point where the run waits for your decision. The gates are criteria (opens on every run, so you approve each AC's `method` and `verified_by`), strategy (2 or more strategy cards), manual (a criterion with a method other than `test`, or `manual: true`, waits for your `ok`; it shows `manual pending`, `manual ok` or `manual problem`, and for a `demonstration` your `ok` ends its evidence file with `human: ok`), plan (before any code) and escalation (the round budget is spent). Merging an MR is your approval on the git host, not a gate.
_Avoid_: Checkpoint, approval step

**Answer**:
Your decision at a gate, such as `approve`, `change` or `abort` at the plan gate. A decision made by an agent is never an answer.
_Avoid_: Sign-off, vote

**Round**:
One return to implementation after the first build, caused by a failing test case, a finding the run lead sends back, or an extra round granted at an escalation, by you or by auto (up to 2).
_Avoid_: Retry, iteration, attempt

**Round budget**:
How many rounds a run may use before you must decide. The default is two.
_Avoid_: Retry limit, max attempts

**Escalation**:
The gate a run reaches when its round budget is spent. You grant one more round, take over, or abort. With `gates.escalation: auto`, Ark grants the first 2 extra rounds itself (`by: auto`) and asks you after that. It never answers an escalation that `ark escalate` requested.
_Avoid_: Failure, stuck run

## Tools

**Orca**:
The desktop app that starts and hosts every agent session and carries messages between them. Master Chief must run in an Orca terminal (ADR 0005).
_Avoid_: Terminal app

**Plannotator**:
The browser surface where you read, annotate and approve a plan. It is optional: the chat works without it (ADR 0005).

**Orca Run and Orca Task**:
Orca's own objects. An Orca Run groups a coordinator and the workers it starts, for example `Master Chief: <project> tickets` or `Ark run <run>`. An Orca Task is a queued entry in Orca's task list. Neither is an Ark run or a ticket.

**Harness**:
The agent program a role runs in: `claude`, `codex`, `omp` or `pi`. `ark.yml` names one for each role.
_Avoid_: Runtime, engine

**Skill and playbook**:
A skill is an entry point, such as `/skill:ark chief`. A playbook is the instructions the skill loads for one role, in `skills/ark/playbooks/`.

## Projects

**Project**:
One workspace plus the settings for its runs: ticket source, models, test suites and round budget.
_Avoid_: Product, estate, manifest

**Workspace**:
The directory a project lives in: a single repo, or a meta-repo that holds several repos. Run leads find the repos by reading it.
_Avoid_: Monorepo, environment

**Repo**:
A git repository in a project's workspace.
_Avoid_: Package, component

**Repo edge**:
A fact that one repo builds against another: a submodule, a package pin, a compose service or an API. The plan lists each edge in its `repos` block, with the evidence the run lead found in the workspace. The edges set the merge order of the MRs, and the hub run page draws them as the repo graph (a card per repo, a labelled edge per repo edge) when the steps work in 2 or more repos. A step `needs` makes none.
_Avoid_: Dependency, link

**Bump step**:
An implementer step in the downstream repo that moves a submodule or package pin to the upstream change of the ticket. The plan names it in the `bump` field of the repo edge. `ark merge-request status` shows its state: `points at upstream branch <8 characters>` (submodule not yet refreshed), `waits for upstream merge` and `waits for upstream publish` (package), or `refreshed to <pin>` once `ark bump refresh` recorded the `bump.refreshed` event. The hub run page shows the same words (one `bumpState` function) on the edge and in the Bump column.
_Avoid_: Update step, pin step

**Worktree**:
A run's own checkout of one repo. A run folder mirrors its workspace: the repos the run touches are worktrees, and everything else links to the workspace.
_Avoid_: Checkout, sandbox

**Bootstrap**:
The one-time work that teaches Ark a project: its stack, its integration and E2E suites, how its repos run together, and its ticket source.
_Avoid_: Setup, onboarding, init

## Improvement

**Retro**:
The review written when a run closes: its cost, time, rework, how much you had to step in, and any escaped defects, compared with earlier runs, plus improvement proposals.
_Avoid_: Postmortem, report

**Improvement proposal**:
A change Master Chief or a run lead suggests, backed by retro evidence: to a project's settings or learnings, to Ark's own process, or to a skill. It takes effect only after you approve it.
_Avoid_: Suggestion, tweak, auto-tune

**Escaped defect**:
A bug found after a run merged and traced back to that run.
_Avoid_: Regression, leak
