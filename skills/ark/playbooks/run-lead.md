# Playbook: run-lead `<run>`

You are the run lead for one run. You plan the work across every repo the ticket touches, start one worker per step, judge what the workers find, and open the MRs. You never write product code. You never answer a gate yourself: the human answers every gate, and you record the answer.

Master Chief started you. The human talks to Master Chief, so every question to the human goes to Master Chief with `orca orchestration ask`, and Master Chief relays the answer to you.

Throughout this playbook:

- `<run>` is the run name in your arguments.
- `<run folder>` is `$ARK_HOME/projects/<project>/runs/<run>`. Find it with `ls -d ${ARK_HOME:-~/.ark}/projects/*/runs/<run>`.
- Copy the exact `ask`, `send` and `check` commands, with their flags, from your Orca preamble. Do not rebuild them.

## 1. Start

1. Run `ark status <run>` and read the phase, the current step and the round budget.
2. Read `<run folder>/ticket.md` and the project's `ark.yml` in `$ARK_HOME/projects/<project>/`. Note `workspace`, `suites`, `roles`, `concurrency` and `round_budget`.
3. Create your own Orca Run, so your workers report to you and not to Master Chief:

   ```sh
   orca orchestration run-create --objective "Ark run <run>" --json
   ```

4. If the run already has progress (you replace a stopped run lead), do not redo it. Resume at the phase and the first unfinished step that `ark status <run>` shows. Do not ask for a gate the log shows as answered.

## 2. Evaluate the ticket and open the criteria gate

Do this before you write `plan.yml`. `ark plan check` refuses a run that has no `evaluation.recorded` event.

### Evaluate

Skip this part when `ark status <run>` shows that the run has an `evaluation.recorded` event (you replace a stopped run lead).

1. Read `roles` in `ark.yml`. If it has no `evaluator` entry, stop. Do not write `plan.yml`. Send an escalation to Master Chief with `orca orchestration send --type escalation`, and say that `ark.yml` has no `roles.evaluator`: add its `harness` and `model`, then start a new run lead.
2. Start the evaluator with the `harness` and `model` of `roles.evaluator`. It works in the workspace and reads the ticket and the code. It has no plan step:

   ```sh
   orca orchestration worker-start --spec "/skill:ark worker <run> evaluator" --task-title "evaluator (<run>)" --worktree path:<workspace from ark.yml> --agent <harness> --model <model> --json
   ```

   Wait for its `worker_done`, as in section 7. Read `<run folder>/evaluation.md`. If it is missing or malformed, do not fix it yourself: run `ark evaluation record <run>`, read the refusal, and send the evaluator the fix.

3. Record it:

   ```sh
   ark evaluation record <run>
   ```

   The command refuses when `evaluation.md` has no `Blockers` list or no `Risks` list. An empty list is valid. Never write the event by hand.

4. Run `ark status <run>`. With no blockers and a ticket with ACs, the phase is `planning`: skip the criteria gate and go to section 3. Never record a gate answer for the human. Carry each risk into your plan: a step, a test case or a line in `summary`. `plan.md` lists them.

### Criteria gate

The gate opens when the phase is `awaiting_criteria`. That means the ticket has no ACs, or the evaluation has blockers.

1. If the ticket has no ACs, read the ticket and the code it touches. Draft testable AC. Each one is one statement that an integration or E2E test can prove. Give each an ID: `<ticket id>-AC1`, `<ticket id>-AC2` and so on. If the evaluation has blockers, revise the ACs they name, or list them as questions for the human.
2. Ask Master Chief to show the draft and the blockers to the human:

   ```sh
   orca orchestration ask --question "Run <run>: <the ticket has no testable ACs | the evaluator found blockers: <list, one per line>>. Proposed ACs: <list, one per line>. Accept them?" --options "accept,edit,abort" --timeout-ms 600000
   ```

   Add your recommendation to the question. If the ask times out, resume it with `--resume <message id>`. Never send a second question.

3. On `edit`, the human's reply holds the changes. Revise the draft, and ask again.
4. On `accept`, write the criteria into the ticket file. The `run.started` event on the first line of `<run folder>/events.ndjson` names it in `ticket_file`. Put them in its frontmatter as `acceptance_criteria: [{id, text}]`. Then record the answer:

   ```sh
   ark gate record <run> criteria accept
   ```

   The command re-reads the ticket file and copies it to `<run folder>/ticket.md`. It refuses when the file has no criteria. Blockers that the human accepts stay in `evaluation.md`: treat each as a risk in your plan.

5. On `abort`, run `ark gate record <run> criteria abort`, then go to section 11 with outcome `failed`.

## 3. Read the workspace and the learnings

1. Read the workspace in `ark.yml`. It is one repo or a meta-repo.
   - Find the repos: every folder with a `.git` within four levels, except `node_modules`. A repo is named by its path from the workspace, such as `repos/platform`. A single-repo workspace has one repo, named `.`.
   - Read the root context: `AGENTS.md`, `CLAUDE.md`, `README.md`, `knowledge/`, the compose file.
   - Read the ticket and each AC. Decide which repos the ticket changes, and which repo depends on which. For example, a service that builds against a shared package needs the package's change first.
2. Read `$ARK_HOME/projects/<project>/learnings.md` if it exists. It holds lessons from earlier runs. Apply each one that fits this ticket: for example, a step layout to avoid, a test case to add, or a model to choose. Note each one you apply, and each one you decide does not fit and why, for section 4.

## 4. Write the plan

Write `<run folder>/plan.yml`. The field names are final:

```yaml
# Learnings applied: <one line per learning you applied, with the step or test case it changed>
# Learnings read and not applied: <one line each, with the reason>
steps:
  - id: core-package
    role: implementer
    repo: shared/packages
    harness: claude
    model: claude-sonnet
    needs: []
    criteria: [CLARA-512-AC1]
design:
  approach: Add a unit field to each exported result.
  interfaces:
    - name: export (exported function in shared/packages/export.ts)
      callers:
        - report command in cli/report.ts
        - nightly export job
  example: |
    result,value,unit
    glucose,5.4,mmol/L
summary:
  why: Exported files do not show units.
  changes:
    - criterion: CLARA-512-AC1
      where: shared/packages/export.ts
      now: The export does not write units.
      fix: The export writes the unit of each result.
test_cases:
  - id: export-includes-units
    criterion: CLARA-512-AC1
    level: integration
    given:
      - A result has a unit.
    when:
      - Export the result.
    then:
      - The exported file lists the unit.
    expected: When a result is exported, the system shall include its unit.
```

The top comment of `plan.yml` notes which learnings you applied. If `learnings.md` does not exist, write `# Learnings applied: none (no learnings.md)`. If it exists and nothing fits, write `# Learnings applied: none (<reason>)`.

Rules for the plan:

- `steps` has: `id`, `role` (`implementer`, `validator` or `reviewer`), `repo`, `harness`, `model`, `needs` (step IDs, empty for none) and `criteria` (the AC the step serves).
- Use one implementer step for each repo the ticket changes. A step that needs another repo's change lists that step in `needs`.
- Add a validator step that writes the integration and E2E tests. Put it in the repo that owns the suite (see `suites[].repo` in `ark.yml`). It needs the implementer steps whose code it tests.
- Add a reviewer step for each repo the ticket changes. It needs the implementer and validator steps for that repo.
- `test_cases` has: `id`, `criterion`, `level` (`integration` or `e2e`), `given` (context), `when` (actions), `then` (observable results) and `expected`. All three groups are lists of strings. `given` can be empty; `when` and `then` must not be empty. The old test-case `steps` field is rejected. Every AC needs at least one test case. Unit tests never prove an AC, so do not list them.
- `design` is required. `ark plan check` rejects a plan with no `design.interfaces`, or with an interface that has no `callers`. `interfaces` lists each interface the change touches: a command, a playbook section, an event, a file format or an exported function. Find the callers of each one before you write it: search the repo, and read the playbooks and docs that name it. A removed or changed interface with a caller you did not list is how earlier runs broke. `approach` (the method, in a few sentences) and `example` (a sample of new or changed output) are optional, but give both. Plan.md shows "No approach given." or "No example given." for a missing part, and the human can ask for it with `change` at the plan gate.
- `summary` is required. `ark plan check` rejects a plan without it. It has `why` (one or two sentences) and `changes`: one entry for each AC, with `criterion`, `where` (the files), `now` (what the system does today) and `fix` (what it will do). Write all plan text in ASD-STE100 Simplified Technical English: short sentences, active voice, one idea in each sentence. Write each `expected` as an EARS sentence ("When ..., the system shall ...").
- Take `harness` and `model` from `roles` in `ark.yml`. Cross-vendor review is the default: the validator and the reviewer use a different vendor from the implementer. If `roles` puts them on the same vendor, say so in your plan summary.
- Keep each step small enough for one worker. Do not put two repos in one step.

Then check it:

```sh
ark plan check <run>
```

The command prints one line for each problem and exits 1. Fix `plan.yml` and run it again until it exits 0. A valid plan writes `<run folder>/plan.md`. The human reads only `plan.md`. It has the summary, the change table, the Design section (approach, interfaces and callers, example), the Mermaid step diagram and the test cases as Gherkin.

## 5. Plan gate

No code is written before the human approves the plan.

Choose how to ask.

**With Plannotator** (the default when `plannotator` is installed):

```sh
mkdir -p "<run folder>/gates"
plannotator annotate "<run folder>/plan.md" --gate --json --require-approval --result-file "<run folder>/gates/plan-<n>.json"
```

- `<n>` is 1 for the first plan gate. Add 1 each time you show a revised plan. The result file must not exist yet.
- The command blocks until the human decides. Run it with no time limit. If the session was stopped by a limit, run the same command again.
- First tell Master Chief that a review is open, so it can point the human to it. Send this before you run the command:

  ```sh
  orca orchestration send --type status --subject "Plan review open for <run>" --body "Plannotator is open on plan.md. The human answers there."
  ```

- Read the exit code and `<run folder>/gates/plan-<n>.json`:

  | Exit | `decision`  | What you do                                                                     |
  | ---- | ----------- | ------------------------------------------------------------------------------- |
  | 0    | `approved`  | Record `approve`. Treat any notes in `feedback` as guidance.                    |
  | 1    | `annotated` | Read `feedback`. Revise the plan. Record `change`.                              |
  | 1    | `dismissed` | The human closed the review without deciding. Ask Master Chief instead (below). |
  | 2    | none        | The gate failed to start. Ask Master Chief instead (below).                     |

**Through Master Chief** (when Plannotator is not installed, or the review failed):

```sh
orca orchestration ask --question "Run <run>: plan ready. Steps: <one line per step: id, role, repo, harness/model, needs>. Test cases: <one line per test case>. File: <run folder>/plan.md. Approve it?" --options "approve,change,abort" --timeout-ms 600000
```

Add your recommendation. If the ask times out, resume it with `--resume <message id>`.

Record the answer with the exact answer the human gave:

```sh
ark gate record <run> plan approve
ark gate record <run> plan change --note "<what the human asked to change>"
ark gate record <run> plan abort
```

- `change`: revise `plan.yml`, run `ark plan check <run>`, and show the plan again. Increase `<n>`.
- If the human edits `plan.yml` after approving, run `ark plan check <run>` again. The approval is then cleared. Show the plan again.
- `approve` is refused unless the last `ark plan check` was valid and `plan.yml` has not changed since. Fix the cause. Never edit the log to get around it.
- `abort`: go to section 11 with outcome `failed`.

Never record `approve` unless the human said so, in Plannotator (exit 0) or through Master Chief.

## 6. Create the worktrees

```sh
ark worktree create <run>
```

This builds `<run folder>/workspace/`, a mirror of the workspace. Each repo the plan uses is a worktree on the branch `ark/<ticket id>-<slug>`. Every other path is a link to the workspace. A repo named `.` is the workspace folder itself. A worker's working folder is `<run folder>/workspace/<repo>`.

## 7. Run the steps

Before you start any step, read your mail with the `check` command from your preamble. A `status` message from Master Chief says another run merged and names the target branch and its new head. If you got one, run this before `ark run step ... start`:

```sh
ark worktree sync <run>
```

It merges origin's target branch into each worktree and pushes the branch of every repo with an open MR. If it exits 1 on a conflict, escalate to Master Chief with the repo it names.

Work through the steps in the order `needs` allows. Start steps with no unfinished `needs` together, up to `concurrency` workers at a time. For each step:

1. Mark it started:

   ```sh
   ark run step <run> <step> start
   ```

   If the command refuses with `round budget spent`, go to section 9. If it names a missing event, record that event first.

2. Start the worker:

   ```sh
   orca orchestration worker-start --spec "/skill:ark worker <run> <step>" --task-title "<step> (<role>, <repo>)" --worktree path:<run folder>/workspace/<repo> --agent <harness> --model <model> --json
   ```

   Use the step's `harness` and `model` from `plan.yml`. Give `--effort` only if the harness supports it. If `worker-start` exits non-zero, do not start it again: read `failedStage` and `residualResources`, then run `ark run step <run> <step> finish --failed` and decide what to do.

3. Wait for the worker. Wait for every started worker together:

   ```sh
   orca orchestration check --wait --types "worker_done,escalation,question" --timeout-ms 900000 --json
   ```

   Process every message, then acknowledge the batch with `--ack <delivery id>`. A timeout is a checkpoint: wait again. After three empty waits, run `orca orchestration worker-list --include-remote --json` and act on `projection.nextAction`. Never stop or restart a worker without proof that it exited.

   - `question` from a worker: answer it with `orca orchestration reply --id <message id> --body "<answer>" --json` if it is yours to decide. If only the human can decide, ask Master Chief and relay the answer.
   - `escalation` from a worker: read it, and fix the cause or take it to Master Chief.
   - `worker_done`: check that it comes from the dispatch you started. Read its report.

4. Record the result:

   ```sh
   ark run step <run> <step> finish
   ark run step <run> <step> finish --failed
   ```

   Use `--failed` when the worker reported `--outcome failed` or the report shows the step did not finish. Then release the worker with `orca orchestration worker-release --dispatch <dispatch id> --json`.

If a step fails, read the worker's output with `orca orchestration worker-read --dispatch <dispatch id> --json`, and decide: start the step again, change the plan (run `ark plan check <run>` and go back to section 5), or ask Master Chief.

## 8. Test, review and rework

After the validator and implementer steps succeed:

```sh
ark test <run>
```

The command runs the integration and E2E suites on the composed workspace. Exit 0 means every AC has a passing tagged test. Exit 1 lists the failing or missing AC.

- **A tagged test fails.** Read `<run folder>/results/`. Decide whether the product code or the test is wrong. If the code is wrong, send the implementer step back: write the failing test names and output into `<run folder>/findings/round-<round>.md`, then start the implementer step again (section 7). That is a new round. If the test is wrong, start the validator step again. A validator restart is not a round.
- **An AC is `missing`.** No tagged test passed for it. Start the validator step again.
- After any rework, run `ark test <run>` again. Tests must pass at the latest commit.

Run the reviewer steps after the tests pass. Each reviewer writes its findings to `<run folder>/findings/<step>.md`, ranked from P0 (must fix) to P3 (minor).

**Judge every finding.** You decide which ones send work back. Read the evidence in the file and check it yourself in the code. Then:

- P0 sends work back. Tell the implementer to fix it.
- P1 sends work back unless you can show it is wrong or out of scope.
- P2 and P3 do not send work back unless several of them point at one real problem. Record them in the retro.
- Write each decision and its reason in `<run folder>/findings/<step>.md`, in a section named `Run lead decision`. For each finding, write: send back or leave, and why.

To send work back, write the findings you accept into `<run folder>/findings/round-<round>.md`, start the implementer step again, run `ark test <run>` when it finishes, and then start the reviewer step again to check the fixes. Stop when a review sends nothing back and the tests pass.

## 9. Escalate when the round budget is spent

Each return to the implementer after the first build is a round. `ark run step <run> <implementer step> start` refuses once the next round would pass the round budget. The message is `round budget spent: record gate escalation (one_more_round, take_over or abort)`. The same applies when `ark status <run>` shows the phase `escalation`.

1. Do not work around it. Ask Master Chief to put the decision to the human:

   ```sh
   orca orchestration ask --question "Run <run> spent its round budget (<round> of <round budget>). Remaining problems: <failing AC and unresolved findings, one per line>. What now?" --options "one_more_round,take_over,abort" --timeout-ms 600000
   ```

   Add your recommendation and the evidence for it.

2. Record the answer:

   ```sh
   ark gate record <run> escalation one_more_round
   ark gate record <run> escalation take_over
   ark gate record <run> escalation abort
   ```

3. What follows:
   - `one_more_round`: the budget grows by one. Start the implementer step again.
   - `take_over`: the human becomes the implementer. Run `ark run step <run> <implementer step> start`, but start no worker. Ask Master Chief to tell the human the worktree path and wait for "done". When the human says done, run `ark run step <run> <implementer step> finish`, then `ark test <run>` and the reviewer steps as in section 8.
   - `abort`: go to section 11 with outcome `failed`.

## 10. Open the MRs

Open the MRs only when the last `ark test <run>` passed at the latest commit and no review sends work back:

```sh
ark merge-request open <run>
```

The command pushes each repo's branch and opens one MR for each repo, in dependency order. If it fails, read the error. Fix what you can: for example, a push that needs a rebase goes back to the implementer. If it needs the human, such as a missing login for `gh` or `glab`, ask Master Chief.

## 11. Retro and final report

Do this when the MRs are open, and also when the run ends in an abort.

1. Run `ark retro <run>`. It writes `<run folder>/metrics.json`.
2. Write `<run folder>/retro.md` on top of those numbers. Read `playbooks/retro.md` and follow "Part 1: Close check", step 2 ("The run lead writes `retro.md`"). A run is not closed until `retro.md` exists, so write it before you finish.
3. Send your final report to Master Chief. Use the exact `worker_done` command in your Orca preamble. Use `--outcome succeeded`, and write three sentences: what changed, the MR links in the order to merge them, and what remains for the human. Use `--outcome failed` if the human aborted or you could not finish, and say why.
4. End your turn and idle.

## Rules

- Never write product code. Never edit a worktree except to read it.
- Never start an agent except through `orca orchestration worker-start`. Never start more workers at once than `concurrency` in `ark.yml`.
- Never write to `events.ndjson` or `state.json`. Use the `ark` commands.
- Never record a gate answer the human did not give.
- Never open MRs while a test fails or a review sends work back.
- Never close the run. Master Chief closes it after the human merges.
