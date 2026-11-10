# Retro playbook

Ark improves only if each run teaches something and the human controls what changes. This playbook has two parts:

- **Write retro.md** (`retro <run>`): runs after every run closes. Master Chief closes the run and computes the numbers, and the run lead writes `retro.md`. It asks the human nothing.
- **Deep interview** (`retro interview`): runs after every 10 closed runs, or on request. Master Chief interviews the human and brings the open improvement proposals for approval.

Master Chief runs the interview. The run lead writes `retro.md`. Neither role writes product code.

## Rules

- An improvement proposal changes nothing until the human approves it. A decision made by an agent is never approval.
- Every proposal has evidence and a scope. A proposal without both is not shown to the human.
- Ask one question at a time. Give a recommended answer with each question, and wait for the human before the next question.
- Never ask the human to score Ark, the run or the agents. Report numbers and ask about patterns.

## Part 1: Write retro.md

### 1. Compute the numbers

When the human merges, abandons or aborts, or when the run hands off, Master Chief closes the run, then computes the numbers:

```sh
ark run close <run> <outcome>
ark retro <run>
```

`outcome` is `merged`, `abandoned`, `aborted` or `handed_off`. Check MR states with `gh pr view <number> --json state` or `glab mr view <number>` before you pick `merged` or `abandoned`. `handed_off` needs no host check: the run has no MR.

`ark retro` writes `~/.ark/projects/<project>/runs/<run>/metrics.json`. If it exits 1, fix the cause it prints and run it again. Do not write `retro.md` without `metrics.json`.

### 2. The run lead writes `retro.md`

A run is not closed until `retro.md` exists. `ark run close` records the outcome, but Master Chief does not tell the human that the run is done until `retro.md` is in the run folder.

Ask the run lead to write it:

```sh
orca orchestration send --to <run-lead-handle> --subject "Write retro.md for <run>" --type handoff --body "Read metrics.json and events.ndjson in <run-folder>. Write retro.md as the retro playbook describes." --json
```

If the send answers `already processing`, the agent is in the middle of a turn: wait 30 seconds, then send again with the request UUID that Orca printed, up to 5 times. Never treat the message as delivered until a send succeeds.

If the run lead has stopped, start a new run lead with the run folder. The event log is the record, so a fresh run lead can write the retro from `events.ndjson`, `state.json` and `metrics.json`.

The run lead writes `<run-folder>/retro.md` with these sections, in this order:

1. **Summary.** One paragraph: the ticket, the outcome, the number of rounds.
2. **Numbers.** Copy them from `metrics.json`; do not recompute them. Cost in USD and tokens per run, role and model (including `cost.by_role.designer`), the ratio of review cost to build cost, wall time split into `time.waiting_on_you_seconds`, `working_seconds`, `waiting_to_merge_seconds` and `idle_seconds` (waiting on you includes the strategy gate wait), rework (rounds, escalations, findings sent back), design rounds (`design_rounds`; they never count as rework and never open the escalation gate), decisions (`decisions.total` and `decisions.overridden`), human intervention (plan-gate changes, MR comments and commits after it opened), the comparison with earlier runs, the models each step really ran (`actual_models`, from the session files the step owns; `helper_models` lists helper calls apart; `cost.by_step.unassigned` is the cost no step owned, plus every `model changed:` line of `ark retro` output, which means the harness failed over from the plan model), and `same_vendor_review` (true means every model of a reviewer step ran on the implementer's vendor, so the review was not cross-vendor; the line `same vendor review:` names the steps; a step that ran two vendors is `mixed`, named in the line `mixed review steps:` of `ark retro` output, and counts as neither; it is a report, not a block). A value that is `unknown` stays `unknown`.
3. **What went wrong.** Each problem once: what happened, which step or event, what it cost (rounds, tokens, time). Cite the event sequence number from `events.ndjson` or the finding. Include escaped defects linked to this run.
4. **Orchestration.** From the orchestration section of `metrics.json`: agent crashes and restarts, stalled workers, dead dispatches, tool errors, context overflows, idle gaps, and the cost of Master Chief and the run lead. Read `orchestration.tool_error_list` (each entry has `tool`, `word`, `count` and `first_error`) and name the owner of the largest entry; do not write "cause not traced" for it. For each problem, name the owner of the fix: Ark, Orca, Plannotator or the harness.
5. **Improvement proposals.** Zero or more. Each has the shape in "Proposal format" below. For each overridden choice (a strategy answer or a plan decision where the human did not take the recommended option), write one proposal of scope `project`. Its change is one `learnings.md` entry that says what the human chose over what, and why if the human said so. Name the strategy or decision ID and its event as the evidence. The deep interview raises it. It changes nothing until the human approves it.

The run lead reads `learnings.md` as a source of what it already knew: a problem that a learning already covers is evidence that the learning did not work, and the proposal says so.

The run is closed when `retro.md` exists. Master Chief tells the human the run is closed.

## Proposal format

Every improvement proposal in `retro.md` uses this shape:

```markdown
### Proposal <number>: <title>

- **Scope:** project | Ark | skill
- **Evidence:** <run id and event sequence number, metrics.json value, or finding; at least one>
- **Change:** <the exact change: the lines for `ark.yml`, `learnings.md` or `verify.md`, the ticket title and ACs, or the skill diff>
- **Status:** proposed
```

Scopes:

- **project:** a change to `ark.yml`, `learnings.md` or `verify.md` for this project only. When the validator finds `verify.md` wrong, the run lead writes a proposal with scope `project`. Wrong means a start or reach command fails, or a feature gives another result than the map says; the validator's findings are the evidence.
- **Ark:** a change to Ark's own process or commands. It becomes a ticket on the Ark backlog.
- **skill:** a change to a skill, shown as a diff.

The status changes to `approved`, `rejected` or `applied` as the proposal moves.

## Apply an approved proposal

Apply a proposal only after the human answers "approve". Then change the status to `applied` and record where it landed.

### Scope: project

- A setting change goes into `~/.ark/projects/<project>/ark.yml`. Edit only the named field. Then validate the config with `ARK_PROJECT=<project> ark status`: exit 0 means it passes, and exit 1 names the field to fix.
- A lesson goes into `~/.ark/projects/<project>/learnings.md`, which run leads read at plan time. Create the file when it does not exist. Append one entry in this form:
  ```markdown
  - <lesson in one sentence>. Evidence: <run id>, <what showed it>. Added <date>.
  ```
- A fix to `verify.md` goes into `~/.ark/projects/<project>/verify.md`. Edit only the named lines of the start, reach or feature map part, run the changed command once to check that it now shows the result the map names, and keep the three-part form of bootstrap step 12.

### Scope: Ark

Create a ticket on the Ark backlog in `~/.ark/projects/ark/tickets/`:

1. Find the next free ID: `ls ~/.ark/projects/ark/tickets/` and take the highest number plus one.
2. Write `~/.ark/projects/ark/tickets/ARK-<number>.md` in the same format as the other tickets there: frontmatter with `id`, `title`, `status: ready`, `milestone`, `traces`, `depends_on` and `acceptance_criteria` (a list of `id` and `text`, each id `AC<k>`, a `method` and a `verified_by` list of test case IDs, plus `manual: true` or a `method` other than `test` for a criterion that only a person can prove), then a `## Why` section that cites the retro evidence. Every AC with `method: test` must have an integration or E2E test case; any other AC has another `method`.
3. Write the ticket into no list of `~/.ark/projects/ark/ROADMAP.md`. Add no row to the tickets README. Only the human ranks it.

### Scope: skill

A skill change is a diff to the skill wherever it lives.

1. Find the skill's directory: `read skill://<name>` resolves it, and in a shell `realpath` of `skill://<name>` prints the physical path. The Ark skill lives in the Ark repo under `skills/ark/`. A project skill lives under the workspace, such as `<workspace>/.claude/skills/<name>/`. A user skill lives under `~/.omp/agent/skills/` or `~/.claude/skills/`.
2. Make the edit in that place, with the `edit` tool.
3. Show the human the diff (`git -C <directory> diff` when the directory is in a git repository) before you tell them it is applied. If the skill is in a repository, leave the change uncommitted for the human to commit.

## Part 2: Deep interview

Master Chief runs a deep interview in two cases:

- **On request.** The human says so, for example `/skill:ark retro interview`.
- **Every 10 closed runs.** `ark chief state` prints `## Interview` with `Closed runs since the last interview: <n>`, and ` (due)` when n is 10 or more. Master Chief reads it at the start and at each ticket. When it says due, offer one: "You have closed <n> runs since the last deep interview. Do one now? Recommended: yes." Do not start it until the human says yes. The count is of runs closed after the newest file in `~/.ark/projects/<project>/interviews/`, so the interview file written in step 3 restarts it.

### 1. Read across the retros

Read every `retro.md` and `metrics.json` of the closed runs counted by `ark chief state`, newest first, and the project's `learnings.md`. List the open improvement proposals (`Status: proposed`) of those runs, grouped by symptom and sorted by the number of runs that show it. Each group needs its evidence: run ids and the lines or numbers. Also note patterns that repeat in at least two retros without a proposal. Examples: the same problem under "What went wrong" in several runs, the same step that cost the most, the same escalation reason, the same human change at the plan gate. Each pattern needs its evidence: run ids and the lines or numbers.

### 2. Ask one question at a time

Ask about one group or pattern at a time, the group with most runs first. Each question names it, shows its evidence in one or two lines, and gives a recommended answer:

> In runs `<run A>` and `<run B>`, the validator missed the same setup step and cost one round each time (`metrics.json` rework). Should `learnings.md` say so? Recommended: yes, add "Run the seed script before the E2E suite", because it fixes both cases.

Wait for the answer. Then ask the next one. Ask no more than 8 questions in one interview. End with: "Is there anything about how you work with Ark that these questions missed?" Recommended: no.

### 3. Turn answers into proposals

Each answer that points to a change becomes a proposal in the format above. Write the proposals in `~/.ark/projects/<project>/interviews/<date>.md` (create the folder when needed) with the evidence from the patterns and the human's answer. A pattern the human did not confirm is not a proposal.

### 4. Approve and apply

Show the proposals one at a time, with a recommended answer for each: "Approve, change or reject?" Apply only the approved ones, by scope, as in "Apply an approved proposal". Record each proposal's status in the interview file. Tell the human what landed and where.
