# Retro playbook

Ark improves only if each run teaches something and the human controls what changes. This playbook has two parts:

- **Close check** (`retro <run>`): runs after every run closes. Master Chief and the run lead produce `retro.md`, and Master Chief asks the human three questions.
- **Deep interview** (`retro interview`): runs across several retros, on request or every N runs. Master Chief interviews the human and brings improvement proposals for approval.

Master Chief runs both parts. The run lead helps only in the close check. Neither role writes product code.

## Rules

- An improvement proposal changes nothing until the human approves it. A decision made by an agent is never approval.
- Every proposal has evidence and a scope. A proposal without both is not shown to the human.
- Ask one question at a time. Give a recommended answer with each question, except the third close question, and wait for the human before the next question.
- Never ask the human to score Ark, the run or the agents. Report numbers and ask the three questions.

## Part 1: Close check

### 1. Compute the numbers

When the human merges, abandons or aborts, or when the run hands off, Master Chief closes the run, then computes the numbers:

```sh
ark run close <run> <outcome>
ark retro <run>
```

`outcome` is `merged`, `abandoned`, `aborted` or `handed_off`. Check MR states with `gh pr view <number> --json state` or `glab mr view <number>` before you pick `merged` or `abandoned`.

`ark retro` writes `~/.ark/projects/<project>/runs/<run>/metrics.json`. If it exits 1, fix the cause it prints and run it again. Do not write `retro.md` without `metrics.json`.

### 2. The run lead writes `retro.md`

A run is not closed until `retro.md` exists. `ark run close` records the outcome, but Master Chief does not tell the human that the run is done until `retro.md` is in the run folder and holds the close check.

Ask the run lead to write it:

```sh
orca orchestration send --to <run-lead-handle> --subject "Write retro.md for <run>" --type handoff --body "Read metrics.json and events.ndjson in <run-folder>. Write retro.md as the retro playbook describes." --json
```

If the run lead has stopped, start a new run lead with the run folder. The event log is the record, so a fresh run lead can write the retro from `events.ndjson`, `state.json` and `metrics.json`.

The run lead writes `<run-folder>/retro.md` with these sections, in this order:

1. **Summary.** One paragraph: the ticket, the outcome, the number of rounds.
2. **Numbers.** Copy them from `metrics.json`; do not recompute them. Cost in USD and tokens per run, role and model (including `cost.by_role.designer`), the ratio of review cost to build cost, wall time with gate wait separate (including the strategy gate wait), rework (rounds, escalations, findings sent back), design rounds (`design_rounds`; they never count as rework and never open the escalation gate), decisions (`decisions.total` and `decisions.overridden`), human intervention (plan-gate changes, MR comments and commits after it opened), and the comparison with earlier runs. A value that is `unknown` stays `unknown`.
3. **What went wrong.** Each problem once: what happened, which step or event, what it cost (rounds, tokens, time). Cite the event sequence number from `events.ndjson` or the finding. Include escaped defects linked to this run.
4. **Orchestration.** From the orchestration section of `metrics.json`: agent crashes and restarts, stalled workers, dead dispatches, tool errors, context overflows, idle gaps, and the cost of Master Chief and the run lead. For each problem, name the owner of the fix: Ark, Orca, Plannotator or the harness.
5. **Improvement proposals.** Zero or more. Each has the shape in "Proposal format" below. For each overridden choice (a strategy answer or a plan decision where the human did not take the recommended option), write one proposal of scope `project`. Its change is one `learnings.md` entry that says what the human chose over what, and why if the human said so. Name the strategy or decision ID and its event as the evidence. Master Chief shows each one at the close check. It changes nothing until the human approves it.
6. **Close check.** Master Chief fills this in (step 3). The run lead leaves the heading and writes nothing under it.

The run lead reads `learnings.md` as a source of what it already knew: a problem that a learning already covers is evidence that the learning did not work, and the proposal says so.

### 3. Master Chief asks the three close questions

When `retro.md` exists, give the human the summary and the numbers in a few lines. Then ask these three questions, one at a time, and wait for each answer. Do not offer a score, a rating or a "how did Ark do" question.

1. **What caused the most pain in this run?** Recommended answer: the biggest item under "What went wrong", named with its cost.
2. **What should change now?** Recommended answer: the proposal with the strongest evidence, named.
3. **What surprised you?** No recommended answer is needed: this one asks for the human's own observation. Offer none and say so ("no recommendation: this is your observation").

Master Chief writes the answers under the "Close check" heading of `retro.md`, in the human's words, as three bullets:

```markdown
- Biggest pain: <answer>
- Change now: <answer>
- Surprise: <answer>
```

Master Chief does not rewrite or grade the answers. If the human names a change, add it to "Improvement proposals" with the human's answer as its evidence.

### 4. Show the proposals

Show each proposal and ask: "Approve, change or reject?" Recommended: approve for a proposal with two or more pieces of evidence, otherwise change it. Apply an approved proposal as in "Apply an approved proposal" below. Rejected proposals stay in `retro.md` with the word `rejected` and the reason, so the deep interview does not raise them again without new evidence.

The run is closed when `retro.md` has its close check, and every proposal has an answer. Tell the human the run is closed.

## Proposal format

Every improvement proposal in `retro.md` uses this shape:

```markdown
### Proposal <number>: <title>

- **Scope:** project | Ark | skill
- **Evidence:** <run id and event sequence number, metrics.json value, or finding; at least one>
- **Change:** <the exact change: the lines for `ark.yml` or `learnings.md`, the ticket title and ACs, or the skill diff>
- **Status:** proposed
```

Scopes:

- **project:** a change to `ark.yml` or `learnings.md` for this project only.
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

### Scope: Ark

Create a ticket on the Ark backlog in `~/.ark/projects/ark/tickets/`:

1. Find the next free ID: `ls ~/.ark/projects/ark/tickets/` and take the highest number plus one.
2. Write `~/.ark/projects/ark/tickets/ARK-<number>.md` in the same format as the other tickets there: frontmatter with `id`, `title`, `status: ready`, `milestone`, `traces`, `depends_on` and `acceptance_criteria` (a list of `id` and `text`, each id `ARK-<number>-AC<k>`), then a `## Why` section that cites the retro evidence. Every AC must be testable at integration or E2E level.
3. Add a row for it to the table in `~/.ark/projects/ark/tickets/README.md`.

### Scope: skill

A skill change is a diff to the skill wherever it lives.

1. Find the skill's directory: `read skill://<name>` resolves it, and in a shell `realpath` of `skill://<name>` prints the physical path. The Ark skill lives in the Ark repo under `skills/ark/`. A project skill lives under the workspace, such as `<workspace>/.claude/skills/<name>/`. A user skill lives under `~/.omp/agent/skills/` or `~/.claude/skills/`.
2. Make the edit in that place, with the `edit` tool.
3. Show the human the diff (`git -C <directory> diff` when the directory is in a git repository) before you tell them it is applied. If the skill is in a repository, leave the change uncommitted for the human to commit.

## Part 2: Deep interview

Master Chief runs a deep interview in two cases:

- **On request.** The human says so, for example `/skill:ark retro interview`.
- **Every N runs.** N is 5 unless the human asked for another number (then record it in `learnings.md`). At the start of a ticket, count closed runs with `retro.md`:
  ```sh
  find ~/.ark/projects/<project>/runs -name retro.md -newer <latest-interview-file> | wc -l
  ```
  Use the newest file in `~/.ark/projects/<project>/interviews/` as `<latest-interview-file>`. When that folder is empty, count every `retro.md` (drop `-newer`). If the count is N or more, offer one: "You have closed <count> runs since the last deep interview. Do one now? Recommended: yes." Do not start it until the human says yes.

### 1. Read across the retros

Read every `retro.md` and `metrics.json` of the project, newest first, and the project's `learnings.md`. Build a short list of patterns that repeat in at least two retros. Examples: the same problem under "What went wrong" in several runs, the same step that cost the most, the same escalation reason, the same human change at the plan gate. Each pattern needs its evidence: run ids and the lines or numbers.

### 2. Ask one question at a time

Ask about one pattern at a time. Each question names the pattern, shows its evidence in one or two lines, and gives a recommended answer:

> In runs `<run A>` and `<run B>`, the validator missed the same setup step and cost one round each time (`metrics.json` rework). Should `learnings.md` say so? Recommended: yes, add "Run the seed script before the E2E suite", because it fixes both cases.

Wait for the answer. Then ask the next one. Ask no more than 8 questions in one interview. End with: "Is there anything about how you work with Ark that these questions missed?" Recommended: no.

### 3. Turn answers into proposals

Each answer that points to a change becomes a proposal in the format above. Write the proposals in `~/.ark/projects/<project>/interviews/<date>.md` (create the folder when needed) with the evidence from the patterns and the human's answer. A pattern the human did not confirm is not a proposal.

### 4. Approve and apply

Show the proposals one at a time, with a recommended answer for each: "Approve, change or reject?" Apply only the approved ones, by scope, as in "Apply an approved proposal". Record each proposal's status in the interview file. Tell the human what landed and where.
