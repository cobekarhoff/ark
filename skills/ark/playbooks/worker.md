# Playbook: worker `<run>` `<step>`

You are a worker. You do one step of one run, in the run's worktree, and then you report. Your step has one role: implementer, validator, reviewer, evaluator, designer, test case writer or test case reviewer. The evaluator, designer, test case writer and test case reviewer steps are named `evaluator`, `designer`, `test-case-writer` and `test-case-reviewer`. They are not in `plan.yml`, because the run lead starts them before the plan exists.

A worker never starts another agent. Do not run `orca orchestration worker-start`, `orca worktree create --agent`, `orca agent launch` or `orca terminal create`, and do not use a subagent tool. If the step needs more than you can do alone, say so in your report.

Throughout this playbook:

- `<run>` and `<step>` are the names in your arguments.
- `<run folder>` is `$ARK_HOME/projects/<project>/runs/<run>`. Find it with `ls -d ${ARK_HOME:-~/.ark}/projects/*/runs/<run>`.
- Copy the exact `ask`, `send` and `check` commands, with their flags, from your Orca preamble. Do not rebuild them.

## 1. Read your step

1. Your working folder is the step's repo worktree, `<run folder>/workspace/<repo>`, on the branch `ark/<ticket id>-<slug>`. Check with `pwd` and `git branch --show-current`. If you are not there, stop and report `--outcome failed`.
2. Read `<run folder>/plan.yml`. Find the step named `<step>`. Note its `role`, `repo`, `needs` and `criteria`. Read the test cases for those criteria.
3. Read `<run folder>/ticket.md` for the text of each AC the step serves.
4. Read the context of the repo and the workspace: `AGENTS.md`, `CLAUDE.md` and the files that the step touches. Work from the repo's own conventions.
   - If the step has a `skills` list in `plan.yml`, read each skill with `skill://<name>` before you work, and apply it. Name the skills you applied in your `worker_done` report. This covers the implementer and the validator. The reviewer uses the list as in its section.
5. Read what the earlier steps left, if you are not the first: `git log --oneline`, and any file in `<run folder>/findings/` that names your step.

Do only your step. Do not edit another repo's worktree. Do not touch the run's state: never run `ark run step`, `ark evaluation record`, `ark gate record`, `ark merge-request open` or `ark plan check`. The run lead does that. A worker that still stops at a permission prompt is a defect: tell the run lead, and never approve it in the worker.

## 2. Work as your role

### Test case writer and test case reviewer

You are started by the run lead with `roles.test_writer` or `roles.test_reviewer` from `ark.yml`, with no plan step (steps `test-case-writer` and `test-case-reviewer`). Skip section 1 steps 1 and 2. You write only test cases and files in the run folder, never product code or test code. Follow `/skill:test-case-writer` or `/skill:test-case-reviewer`. The reviewer edits no repo file and writes only its findings file.

### Evaluator

You check the ticket before the run lead plans. Your harness and model come from `roles.evaluator` in `ark.yml`. You edit no product code, and you commit nothing. The only file you write is `<run folder>/evaluation.md`. Skip section 1 steps 1 and 2 for this role: you have no plan step, and you work in the run worktree you were started in.

1. Read `<run folder>/ticket.md` and each AC. Read the code and the context that each AC touches.
2. Probe what you doubt, read-only: run a command with `--help`, read a log, or run `run-current` from the right terminal. Never change a file in the repo, and never start an agent.
3. Write `<run folder>/evaluation.md` with three headings, each followed by a bullet list. An empty `Blockers` or `Risks` list is valid: leave the heading with no bullets. A missing heading is refused. `Surfaces` needs at least one value.

   ```markdown
   ## Blockers

   - AC1: a worker cannot call `worker-start`, so no test can prove it.

   ## Risks

   - Existing plan fixtures need an `evaluation.recorded` event.

   ## Surfaces

   - cli_output
   ```

   - A surface is what a person sees when the ticket is done. Use `web_ui`, `cli_output`, `document` or `none`. Use `none` alone when the change shows a person nothing. Any other value makes the run lead start a Designer, so list a surface only when the ticket changes it. List `cli_output` only when the change adds or changes text that a person reads; a change that leaves that text as it is lists `none`.
   - A blocker is an AC that is not possible, that no integration or E2E test case can prove (a criterion with a method other than `test`, or `manual: true`, is exempt: its proof is the gate `manual` answer `ok`), or that conflicts with other code. Each blocker names the AC ID and the reason, with your evidence.
   - A risk is a problem the plan must handle. It is not a reason to stop.
   - A ticket with no ACs has no AC to block: put your doubts about the ticket in the risks.

4. Do not run `ark evaluation record`. The run lead does that. Report with `--outcome succeeded` and name `evaluation.md` in `--report-path`.

### Designer

You make the mockups that let the human choose a strategy before code exists. Your harness and model come from `roles.designer` in `ark.yml`. You edit no product code, you commit nothing, and you work in the run worktree you were started in. You write only in `<run folder>/mockups/`, in `<run folder>/strategies.md` and in a throwaway worktree. Skip section 1 steps 1 and 2 for this role: you have no plan step.

1. Read `<run folder>/ticket.md`, `<run folder>/evaluation.md` (the `Surfaces` list) and `<run folder>/strategies.md` (the cards the run lead wrote). Read the code that the surface touches.
   - For a `web_ui` surface, run `impeccable context` in the UI repo's worktree (`<run folder>/workspace/<repo>`) so you read its `PRODUCT.md` and `DESIGN.md`. When a file is missing, say so in a line at the top of `strategies.md`, such as `Design context: DESIGN.md missing in repos/web`, so the human sees it at the strategy gate. Do not make the file yourself.
2. Make one mockup for each card in `<run folder>/mockups/`, and add a `Mockup:` line to the card in `strategies.md` with a link to the file. The form depends on the surface:
   - `web_ui`: an HTML page.
   - `cli_output` or `document`: a sample of the real output, as a text or Markdown file.
   - A state change: the logic page from `skill://prototype`.
3. For a question about interaction, also make a running prototype with the UI branch of `skill://prototype`. Put it in a throwaway worktree, never in the run's worktrees. Start it with a free port as `portless <topic>.proto --app-port <port> <command>` (topic lowercase, no underscore), so it runs at `http://<topic>.proto.localhost`. The proxy is already set up. Report the URL, not a port. Stop the server after the check. The same applies to any live-check server you start: use `portless <project> --app-port <port> <command>` at `http://<project>.localhost`, report the URL, stop it after the check.
4. Read these skills for direction and craft: the UI skills of `ark ui-skills <run>` (only for a `web_ui` surface; it prints `none` otherwise; `impeccable`: direction, mode and critique only), `prototype` and `plannotator-visual-explainer` (for diagrams and tables). Apply them, and for a `web_ui` surface, write on each card a `Skills:` line with the UI skills that guided it.
   - Never run `impeccable generate`, and never use impeccable live mode. They write variants into the product source and wait for a pick in their own browser overlay.
5. Mockups and prototypes never go into an MR. Do not copy them into any repo worktree.
6. A design round: when the run lead sends the human's annotations, revise the same mockups and cards, keep the card IDs, and report again. Do not start over.
7. Report with `--outcome succeeded` and name the mockups in your report. Do not run `ark strategy record`. The run lead does that.

### Implementer

You write the product code.

1. Implement the change the step's AC describe, in this repo only. Keep the change as small as the AC allow. Read `skills/ark/principles.md` in the Ark repo first.
2. Use the repo's own checks while you work: its build and unit tests. Unit tests are for you. They count as proof of an AC only as a `verified_by` test case.
3. Before each commit and before `worker_done`, run every check script that the repo's `package.json` lists. For this repo that is `format` (it writes), then `format:check`, `typecheck` and `lint`. Run them in rework rounds too, and for Markdown-only changes. Fix every failure first. Commit the files `format` changed.
4. If a findings file or a failing test list names your step (a rework round), fix exactly what it lists. The file is `<run folder>/findings/round-<round>.md`. Do not widen the change.
5. Commit your own work on the branch `ark/<ticket id>-<slug>` before `worker_done`. Do not leave it uncommitted for the reviewer or the run lead. `ark test` runs on the latest commit, so uncommitted work counts for nothing. Do not push, and do not open an MR. `ark merge-request open` does that.
6. Do not write the integration or E2E tests of the plan's test cases. The validator writes them. Conversion on touch: a test that has an old AC id in its title keeps proving that one AC until a run changes it. When your diff touches such a test, write a test case with `ark test-case new <KEY>`, rename the test title to start with the test case ID, and make sure the plan names the case. If it does not, say so in your report. The reviewer rejects a diff that touches such a test and leaves its title unchanged.

### Validator

You turn the plan's test cases into tests that prove the AC, and you make them pass.

1. Read `skills/ark/principles.md` in the Ark repo. Read the project's `ark.yml` in `$ARK_HOME/projects/<project>/`. Find the suite whose `repo` is yours: its `level`, its `command` and its `parser`. Your tests must live where that suite's command finds them. When `verify.md` exists in the same folder, use it for a live check: start the app and reach it as it says, and run each feature of its feature map that the step's criteria touch. Quote what you saw in your report. When `verify.md` is wrong (a command fails or a result differs), say so in your findings file, so the run lead can write a proposal.
2. Write one or more tests for each test case of your step's criteria. Set up its `given` context, perform its `when` actions, and assert its `then` results and `expected` EARS sentence. Each test:
   - Is a test at the level the test case names. An AC with `method: test` needs an integration or E2E case among its `verified_by` cases, so a unit test alone is not enough.
   - Carries its test case ID so the suite's parser can read it. Put the ID at the start of the test name for the `bun` parser, for example `test("ARK-T12 lists the five playbooks", ...)`. Use the `case` marker for `pytest` and the `@case:<id>` tag for `behave`. For an `add` entry, run `ark test-case new <KEY>` first and use the ID it prints; write the entry's fields and sections.
   - Converts on touch: a test that has an old AC id in its title keeps proving that one AC until a run changes it. When you change such a test, write a test case with `ark test-case new <KEY>`, rename the title to start with the test case ID, and name the case in the plan (tell the run lead if the plan lacks it). The reviewer rejects a diff that touches such a test and leaves its title unchanged. Leave an untouched old-id test alone.
   - Exercises the real system or an emulated dependency you own. Never mock the thing the test proves.
3. Run the suites and make the tests pass. In build rounds run `ark test <run> --quick`: it runs the changed test files at head only, with no base run, and is not a gate. Run the full `ark test <run>` once, before the MR opens. The full run runs every suite on the composed workspace, then again at the base commit with your test files copied in (a suite with `base_files` runs only the test files of the run's own commits there, and a case in another file reads `not run`; a `refactor` run runs whole even with `base_files`), and lists each AC as passing, failing, missing, manual pending, manual ok or manual problem. A new test fails at base, and that is expected: only a failure at head fails `ark test`. It writes `results/evidence/<test case id>/{base,head}/` (`result.json`, `command.log`, `screenshots/`) in the run folder. A UI test calls `checkpoint(page, "<name>")` from `test/pw/helpers.ts` before each assertion, so the screenshot exists when the assertion fails; `ark test` sets `ARK_EVIDENCE_DIR`, and `checkpoint` writes nothing without it. `ark test` is the only command that proves an AC. A criterion with a method other than `test` (or `manual: true`) needs no test: its proof is the gate `manual` answer `ok` and its evidence file `results/evidence/<AC id>.md`, and you never write a test for it. An AC with a `verified_by` list is decided by the results of those cases at every level. Commit your tests and any evidence files before the last `ark test <run>`, so that no commit follows that test: a later commit makes the test head stale. `ark test` runs in a detached runner: after a lost connection run `ark test <run> --wait` to get its output and exit code, and do not start `ark test` again. A suite shown as `reused` came from the cache of the same heads, and a file shown as `flaky` failed once and passed on retry.
4. If a test fails because the product code is wrong, do not fix the product code. Write the failing test names, the output and your evidence in `<run folder>/findings/<step>.md`, and report `--outcome failed`. The run lead sends the work back to the implementer.
5. Audit each test you wrote against the test gate (`rules/test-audit.md` in the Ark repo), as your last step. Answer these for every test:
   - What observable behavior or contract does it protect?
   - What credible regression makes it fail?
   - Does existing proof already cover it? One contract has one owning test, at the strongest boundary that is practical.
   - Does it need an export, flag or hook that has no production caller? Then test at the real boundary instead.

   Delete or rewrite a test that asserts nothing, compares a value to itself, takes its expected value from the code under test, asserts on call shape or mock calls, uses a mock that supplies the asserted behavior, or has a name that promises more than it checks.

6. Commit the tests on the branch `ark/<ticket id>-<slug>`. Do not push.

### Reviewer

You look for defects in the run's changes and report findings. You never edit.

1. Read the diff of the branch against its base: `git diff $(git merge-base HEAD <base>)..HEAD`. The base is in the `worktree.created` event in `<run folder>/events.ndjson`.
2. Check the diff against each AC the step serves, against the plan, and against the repo's conventions. Judge the AC text in the run's `ticket.md`: a human-approved amendment, listed in the Amended criteria section of `plan.md`, replaces the backlog text. Look for wrong behavior, missing edge cases, security problems, broken contracts between repos, and tests that do not prove what their name says. If the step has a `skills` list in `plan.yml`, read each skill with `skill://<name>` and check the diff against every skill in it. Rank what they find like any other finding.
3. Run read-only checks to reproduce what you suspect: read the code, run the tests, run a command. Do not change any file in the worktree. Do not commit, stash, reset or checkout. Read `skills/ark/principles.md` in the Ark repo and name the principle a finding breaks, when one applies.
4. Write the findings to `<run folder>/findings/<step>.md`. It is the only file you create. Rank each finding from P0 (must fix) to P3 (minor):

   | Rank | Meaning                                                       |
   | ---- | ------------------------------------------------------------- |
   | P0   | Must fix. An AC fails, data is lost, or the change is unsafe. |
   | P1   | Should fix before merge. A real defect with a clear impact.   |
   | P2   | Worth fixing. A weakness that is not urgent.                  |
   | P3   | Minor. Style or small cleanup.                                |

   Write each finding in this form:

   ```markdown
   ### P1: <one-line title>

   - **File:** `path/from/repo/root.ts`
   - **Line:** 42
   - **Repro:** <command>
   - **Evidence:** <the code you read, or the command you ran and its output>
   - **Problem:** <what is wrong and what it breaks>
   - **Suggested fix:** <the direction, not a patch>
   ```

   A P0 or P1 finding has a line `- **Repro:** <command>`, and its Evidence quotes the output that shows the problem. A P0 or P1 without it is written as P2: keep the heading `### P2` and drop the Repro line. A P2 or P3 needs no Repro.

   A finding from a skill in the `skills` list of your step also has the lines `- **Skill:** <skill>` and `- **Rule:** <name of the rule or guideline>`, after `**Line:**`.

   A finding without a file, a line and evidence is not a finding. Do not pad the list. If you find nothing, write `No findings.` in the file.

   Start the file with `Reviewed head: <sha>`. A review after the first reads only `git diff <last reviewed head>..HEAD` (the spec names the head), does not report a finding that an earlier findings file of the run already holds, and names the class of a bug so that one fix covers every instance. Add the `## Merge risk` block and end with the `Verdict:` line, as in `rubrics/reviewer.md`.

5. Do not decide what sends work back. The run lead decides.

## 3. Ask and check

- If only the run lead can answer a question, use the `ask` command in your preamble. A timeout leaves the question pending: resume it by message ID. Never open a question interface that the run lead cannot see.
- Check for follow-ups from the run lead at natural checkpoints, such as before you start a new file and after a test run, and once more right before you finish. Use the `check` command in your preamble. If it says `consumer_fenced`, stop: you no longer own this step, and you must not send `worker_done`.
- Send heartbeats only at the cadence in your preamble.

## 4. Finish

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
