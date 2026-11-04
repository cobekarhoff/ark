# Command reference

This page describes the `ark` CLI. The command section is generated from `ark --help` by `scripts/cli-reference.ts`. Run `bun scripts/cli-reference.ts` after you change a help text. The sections after it are written by hand.

Every command except `ark run start` takes a run id. `ark` finds the run by scanning `$ARK_HOME/projects/*/runs/<run>`. `ARK_HOME` defaults to `~/.ark`. A run id looks like `2026-10-29-CLARA-512-1`: the date, the ticket id, and the next free number for that ticket and date. Each of these commands takes `--project <name>`: `ark` then looks for the run in that project only, and exits 1 when the project does not exist or does not hold the run. Without it, `ark` scans every project and refuses a run id that exists in several. Only `ark run start` and `ark status` read `ARK_PROJECT`.

`ark run start` finds the project in this order: the `--project <name>` flag, the `ARK_PROJECT` environment variable, then the project whose folder contains the ticket file.

Every command prints a short result and exits 0 on success. On failure, a command prints `ark: <reason>` to stderr and exits 1. Every command rebuilds `state.json` from the event log before it runs.

## Commands

<!-- generated:commands:start -->

### run start

```text
ark run start <ticket-file> [--project <name>]

Starts a run from a ticket file. It creates the run folder, copies the ticket and records the first event. It prints the run ID.

Where the project has `ticket_source: local`, it also sets the first `status:` line of the ticket file to `in_progress` and changes no other line. A refused start leaves the file unchanged. A ticket may set `kind: bug`, `perf`, `refactor` or `feature` (default `feature`); any other value exits 1 and names the allowed kinds. The kind is in `run.started`.
```

### run step

```text
ark run step <run> <step> start|finish [--failed] [--not-started] [--merge] [--project <name>]

Records that a plan step started or finished. Use --failed with finish when the step failed. Use --not-started with finish --failed when the worker never ran (worker-start exited non-zero and no worker is running): it records not_started: true on step.finished, takes back the round of that start, and the retro does not count the step. It is a usage error without --failed, and with start or --merge. A step can start only after you approve the plan. Use --merge with start to run an implementer step that fixes a sync conflict: it costs no round, and it needs a failed ark worktree sync for the step repo. With `gates.escalation: auto` in ark.yml, an implementer start that is refused only because the round budget is spent, or because the MRs are open and no escalation answer exists, records gate escalation one_more_round by auto first and prints `escalation one_more_round by auto (<n> of 2)`; at most 2 such answers per run (a --merge answer prints `(merge, not counted)` and does not count), never while escalation.requested is pending, and the third refusal is the usual one. For a `bug` run it refuses an implementer start with `bug run: record a failing ark test of the ACs before the fix` until a `test.completed` has every non-manual AC `failing`.
```

### run close

```text
ark run close [<run> <outcome>] [--sweep] [--project <name>]

Closes a run. The outcome is merged, abandoned, aborted or handed_off. Ark refuses an outcome that does not fit the run, such as merged with no MRs. For merged it deletes each repo's branch when its MR is merged (or, with no MR, when the branch is in the target branch); when `git fetch` fails and the MR state is unknown it keeps the branch and prints `kept     <repo>  <branch>: <reason>`. For handed_off Ark first applies the refusals of `ark merge-request open`, before it appends the event or removes a worktree: a non-manual criterion not `passing` in the last test, a manual criterion with no ok, a repo head changed since the last test, a counted AC string in no tracked file or a `not:` string still in one, a `kind: perf` run with a missing result file and a `kind: refactor` run whose base did not pass. Only a string a file can hold counts: not one with a placeholder (`<`), a `*`, `...`, a `:<line>` suffix or the id of its own AC, and no string of a manual AC. A string that starts with `not:` is a removed string: it must be in no tracked file, and the refusal names it without the prefix. For handed_off it keeps each branch with commits beyond its base (the base is in `worktree.created`) and prints `kept     <repo>  <branch>: handed off, <n> commit(s) ahead of <base>` for each; it deletes a branch with no commit beyond its base. After the close it releases the settled Orca workers of the run (Orca Run `Ark run <run>`) and prints one line for each; it prints `<dispatch id> still active, not released` for an active one, and one `orca: workers not released: <reason>` line when Orca fails, and the close still exits 0. `ark run close --sweep [--project <name>]` does the same release for every closed run of the project (ARK_PROJECT when --project is not given), records no event, and prints nothing for a run with nothing to report. --sweep takes no run argument.

Where the project has `ticket_source: local`, it then sets the first `status:` line of the run's ticket file (`ticket_file` of `run.started`) to `done` for merged and to `ready` for aborted and abandoned, and changes no other line. handed_off leaves the file as it is. A missing ticket file prints a `warning:` line and the close still succeeds.
```

### evaluation record

```text
ark evaluation record <run> [--project <name>]

Reads evaluation.md in the run folder and records its blockers, risks and surfaces (web_ui, cli_output, document or none). It refuses a missing file, a file with no Blockers, Risks or Surfaces list, an unknown surface, and a project whose ark.yml has no roles.evaluator. Blockers open the criteria gate; no blockers send the run to planning.
```

### criteria amend

```text
ark criteria amend <run> <criterion id> <file> [--project <name>]

Writes the text in <file> as the new text of one criterion in the run's ticket.md (frontmatter and table row) and records criteria.amended with the criterion, the old text and the new text. Use it for an amendment the human approved. It refuses an unknown criterion, an empty file, and a run outside the phases awaiting_strategy and planning. It clears the plan check: run ark plan check again so plan.md lists the amendment before the plan gate.
```

### strategy record

```text
ark strategy record <run> [--project <name>]

Reads strategies.md in the run folder and records its strategy cards: the count, the recommended card and the card IDs. It refuses a missing file, a card with no approach, interfaces or tradeoffs, a mockup link to a file that is not in the run folder, a run with no evaluation record, one card with no reason, and, when the evaluation lists a surface other than none, a card with no mockup link or no Skills line, a Skills line that names a skill `ark ui-skills <run>` does not list, or a project whose ark.yml has no roles.designer. A mockup, a Skills line and roles.designer are not needed when the surface is only none, or when there is one card and the surface is only document. Two or more cards open the strategy gate; one card opens no gate.
```

### ui-skills

```text
ark ui-skills <run> [--project <name>]

Prints the UI skills of the run, one line for each. When the Surfaces list in the recorded evaluation is not none, it prints the required skills, then one more line for the React skill, which is only for a change that touches React code. When Surfaces is none, it prints none. It exits 1 for a run with no recorded evaluation. The Designer, the implementer, the validator and the reviewer read these skills; strategy record and plan check refuse a Skills line or a skills list that names any other skill.
```

### plan check

```text
ark plan check <run> [--project <name>]

Checks plan.yml in the run folder and renders plan.md. It prints one line for each problem and exits 1 when the plan is invalid. A plan with no summary is invalid, and so is a summary with no row for an AC of the ticket. A plan with no `design.interfaces` is invalid, and so is an interface with no name or with no `callers`, or with a blank caller. A plan with a cycle, an unknown `needs`, a duplicate step id, an unknown role, or a step with no id, role, repo, harness or model is invalid. A summary with no why, no changes, or a change with no criterion, where, now or fix is invalid. A decision with no id, a duplicate id, no question, an option with no label, or a `recommended` or `chosen` that is not an option, is invalid. A test case with a level other than integration or e2e is invalid. A criterion with no integration or e2e test case is invalid, and so is a test case with an empty list or no expected sentence. A decision with fewer than 2 or more than 4 options is invalid. A step whose harness and model are not the pair of any entry in roles in ark.yml is invalid: the problem names the step, its pair and the allowed pairs. It refuses a run with no strategy record or with an open strategy gate. When the evaluation lists a surface other than none, it also needs a skills list in at least one step, only skills that `ark ui-skills <run>` lists, and every required skill in each non-empty list; plan.md then has a Skills column. A run with no recorded evaluation counts as none. It records the number of open decisions. For `kind: bug` the first step must be a validator step that serves every AC, a manual one too. For `kind: perf` the `goal` of the first step must name `results/baseline.md` and the `goal` of the last step must name `results/compare.md`. `goal` is an optional step text.
```

### worktree anchor

```text
ark worktree anchor <run> [--project <name>]

Makes the run's worktree early, for the first repo of the workspace, with the same branch, `setup` and `worktree.created` event as `worktree create`. It prints one line, `path:<absolute path>`, the folder to start the run lead and its first workers in. A second call prints the same line and records nothing. A later `worktree create` prints `exists` for that repo. A repo with `repos.<repo>.base` in ark.yml starts from `origin/<base>` after `git fetch origin <base>`, not from the clone's HEAD; a failed fetch exits 1, names the repo and makes no worktree. If `setup` exits non-zero it removes the worktree and exits 1, as `worktree create` does. It refuses a closed run.
```

### worktree create

```text
ark worktree create <run> [<repo>...] [--allow-dirty] [--project <name>]

Builds the run's workspace mirror. A repo with `repos.<repo>.base` in ark.yml gets its worktree from `origin/<base>` after `git fetch origin <base>`, not from the clone's HEAD; if that fetch fails the command exits 1, names the repo and the fetch error, and makes no worktree for it. Each named repo, or every repo the plan uses, gets a worktree on the branch `ark/<ticket id>-<slug>`, or on the lowest free `-2`, `-3`, ... suffix when that name exists locally or on origin; `worktree.created` records the branch. Before it adds any worktree it checks every nested repo that has none yet for uncommitted changes: it prints the changed paths and exits 1, and makes nothing. With `--allow-dirty` it prints the paths as a warning and branches from HEAD without those changes. The root repo `.` is never refused and needs no flag: when the command makes the root worktree and the root has uncommitted changes, it prints `warning  .        <workspace> has <n> uncommitted changes, not in the worktree` and the paths on stderr, once per run, and exits 0. Every other path is a symlink to the workspace. When `ark.yml` sets `setup`, the command runs it with `sh -c` in each new worktree. If `setup` exits non-zero, the command removes that worktree and its branch, prints the repo, the exit code and the last 10 lines of stderr (of stdout when stderr is empty), and exits 1. If the removal fails, the output names each `left behind` worktree path and branch. It records the worktree only after `setup` passes. A repo folder with a `.git` and no recorded worktree is a stale leftover: the next create removes it, then runs `setup` again.
```

### test

```text
ark test <run> [--project <name>]

Runs the project's suites on the run's workspace mirror and records which ACs have a passing test. A criterion with `manual: true` in ticket.md has no test: it shows `manual pending`, `manual ok` or `manual problem` from the manual gate, even when a test is tagged with it. It exits 1 unless every AC is passing or manual ok. `passed` in test.completed counts the automated criteria only, so a manual pending never opens the escalation gate. It first runs each entry of `checks` in `ark.yml` (`{ name, repo, command }`) in its repo worktree, before the suites. A check that exits non-zero prints `check <name> failed` and the last 20 lines of its output, and records `passed: false`. For `kind: refactor` it also runs the suites on a throwaway checkout at the base commit of each worktree, once per run, and records `base_passed`.
```

### gate record

```text
ark gate record <run> <gate> [<criterion id>] <answer> [--note <text>] [--project <name>]

Records your answer to a gate. The gates are criteria, strategy, plan, escalation and manual. The strategy gate takes the ID of a card in the latest strategy record, or abort. The manual gate proves one criterion that has `manual: true` in ticket.md: `ark gate record <run> manual <criterion id> ok|problem [--note <text>]` records gate.answered with the field `criterion`; it refuses an ID that is not in the ticket or not manual, and the answer is never automatic. Ark refuses an answer that the run's state does not allow, and refuses plan approve while the plan has an open decision.
```

### escalate

```text
ark escalate <run> --reason <text> [--project <name>]

Opens the escalation gate when the round budget is spent, also when the last ark test passed. Use it for an unresolved review P0 or P1. It records escalation.requested with the reason. It refuses a run that is not in phase building, a round budget that is not spent, and an empty reason. Answer the gate with ark gate record.
```

### merge-request open

```text
ark merge-request open <run> [--project <name>]

Pushes each repo's branch and opens one MR for each repo, in dependency order. It refuses, with exit 1 and before any push, when a repo head changed since the last test, and ends the error with `run ark test <run> again`. It also refuses, before any push, when a criterion with `manual: true` has no manual ok, and names each one. The MR targets `repos.<repo>.base` when ark.yml sets it (`gh pr create --base <base>`, `glab mr create --target-branch <base>`), else the branch origin/HEAD names. No command merges. For a project with `merge_requests: none` in ark.yml it exits 1 before any command runs and prints `project <project> has merge_requests: none: close the run with ark run close <run> handed_off`. It also refuses, before any push, when a non-manual AC is not `passing` in the last test (it names each), when a string in backticks in an AC text is in no tracked file of a run worktree at HEAD (it names the AC and the string; Only a string a file can hold counts: not one with a placeholder (`<`), a `*`, `...`, a `:<line>` suffix or the id of its own AC, and no string of a manual AC. A string that starts with `not:` is a removed string: it must be in no tracked file, and the refusal names it without the prefix.), for `kind: perf` when `results/baseline.md` or `results/compare.md` is missing or empty, and for `kind: refactor` unless `base_passed` is true.
```

### merge-request status

```text
ark merge-request status <run> [--since <time>] [--json] [--project <name>]

For a project with `merge_requests: none` it prints `merge requests: none`, exits 0 and calls no gh and no glab. Otherwise it prints each MR of the run as `<repo>  <state>  <url>`, then `ci: passed|failed|running|none|unknown`, `conflict` when the MR cannot merge into its target branch (`conflict: unknown` when the host cannot say), and `checks failing: <names>`, read from gh or glab. With --since <ISO 8601 time> it also lists each human comment written after that time (bots and the logged-in Ark user left out), indented under its MR with author, file:line, body and URL; `comments: unknown` when they cannot be read. With --json it prints one array of {repo,url,state,ci,failedChecks:[{name,url}],conflict,comments}; conflict and comments are null when unknown. A value gh or glab cannot answer prints `unknown` and the command exits 0; unknown is never a pass. It changes nothing.
```

### worktree sync

```text
ark worktree sync <run> [--project <name>]

Fetches and merges origin's target branch (`repos.<repo>.base` when set, else the branch origin/HEAD names) into each worktree of the run, and pushes the branch of each repo that has an MR (never for a project with `merge_requests: none`). It records worktree.synced for each repo. On a conflict it records it, undoes the merge and goes on to the next repo. After the last repo it exits 1 and names every conflicting repo. A closed run gets a phase error and its worktrees stay unchanged. It never merges an MR.
```

### workspace sync

```text
ark workspace sync <run> [--project <name>]

Fetches and fast-forwards the target branch (`repos.<repo>.base` when set, else the branch origin/HEAD names) of the workspace checkout of each repo the run touched. It exits 1 and names the repo when git refuses, for example on a conflicting local change. It prints repo, branch and head.
```

### status

```text
ark status [<run>] [--project <name>]

Prints the state of one run: phase, round, first unfinished step, waiting gate, last test, test head, MRs and cost. The test head line is `test head: current` when every worktree is at the head of the last test, and one `test head: stale (<repo> tested <8 characters>, now <8 characters>)` line for each repo that changed. There is no test head line before the first test. For a project with `merge_requests: none` it prints `merge requests: none (local only)` in place of the MR lines, then `branch   <repo>  <branch>  <n> commit(s) ahead of <base, 8 characters>` for each worktree whose branch has commits beyond its base, also after `ark run close <run> handed_off`. Without a run, it lists every open run. --project limits the config check to one project, like ARK_PROJECT, and with a run it looks for the run in that project only.

The list adds the age of the newest event of each open run after the step, as `Nm`, `Nh` or `Nd` (largest whole unit; hours up to 47), and ends the line with `  stale` when that age is over 24 hours: `<run>  <phase>  <step>  <age>[  stale]`. It prints the `kind` of the run after the ticket line.
```

### retro

```text
ark retro <run> [--project <name>]

Computes the run's cost, time, rework and intervention metrics and writes metrics.json. The `rework` object holds `rounds` (highest round of a non-merge step), `escalations` (escalation gate answers) and `findings_sent_back` (lines in each `findings/round-<n>.md` file that start, after optional `#` marks, one list marker (`N.`, `-` or `*`) and bold marks, with `P0`, `P1`, `P2` or `P3`; no findings folder counts 0). `rework.merge_steps` counts steps started with `--merge`. `human_intervention.plan_changes` counts the plan `change` answers plus every plan `approve` answer after the first, whoever gave it (`by` human or auto): `plan_changes: 0` for a plan approved once, `plan_changes: 2` for one change and a second approve. `actual_models` maps each plan step ID to the sorted, unique models of its sessions (an empty list when no session was found). For each step whose session models differ from its model in plan.yml (compared without a provider prefix, so `anthropic/claude-x` matches `claude-x`), it prints `model changed: step <step> planned <plan model>, ran <models>`; a run with no readable plan.yml prints none. `same_vendor_review` is true when a validator or reviewer step ran on the same vendor as an implementer step in the same repo (`claude-` is anthropic, `gpt-` is openai, any other model has no vendor); it prints `same vendor review: true (<steps>)` or `false`. Both are reports only.
```

### chief state

```text
ark chief state [--project <name>]

Prints a Markdown snapshot of Master Chief's state, read live from its sources and never from a file: open runs with phase and current step, run leads (live ones only, dispatch and terminal) from `orca orchestration worker-list`, which reads Master Chief's own Orca Run; `task-list` reads the same Run for the queue, queued Orca Tasks (`ready` and `pending`), the head of the workspace's main branch, `gates` and `concurrency` from ark.yml, closed runs with an empty Close check and free disk space. It reads every page of the Run list, so a Master Chief Run past the first page is found. A source that fails prints `unavailable: <command> failed: <reason>` under its heading, and the other sections still print. An empty source prints `none`. --project falls back to ARK_PROJECT.
```

### chief handover

```text
ark chief handover [--project <name>]

Starts a new Master Chief for the project with `orca agent launch --surface terminal`, using `roles.chief` from ark.yml, and prints the new terminal handle. The prompt names the old Master Chief terminal (found with the live Master Chief of the project), tells the agent to wait until that terminal is gone, and then to run `run-use` on the existing Master Chief Run. It never closes the old terminal: Master Chief does that after the command returns. It exits 1 and starts nothing when no live Master Chief exists, when Orca does not answer or when `roles.chief` is not set. --project falls back to ARK_PROJECT.
```

### ui

```text
ark ui [--port <number>] [--name <host>]

Serves the hub in hub/ on 127.0.0.1, port 4317 unless --port says otherwise (0 picks a free port). --name <host> (such as ark.localhost) also lets the hub answer to that name. One background reader builds a snapshot of the runs, plans, models, MRs, usage cost and backlog; the page gets it over one Server-Sent Events stream (/events; GET /api/snapshot returns the same JSON). A closed run, its decisions, files and agent transcripts are read when the page asks, not kept in the snapshot. Views: Home (tiles for what needs you, then blockers, the review queue and run progress with usage), Runs (every run on one board and a cross-run dependency graph; #/map redirects here), a run page (any run: progress strip, plan, agents, MR evidence, decisions, files, transcripts) and Backlog (grouped table; a ticket opens as a full page with its dependency graph; the ticket text is read when the page asks, GET /api/ticket/<project>/<id>). The hub's one action is POST /api/open-in-orca, which runs orca terminal switch for a live terminal; it sends no text to a terminal, changes no run state and steers no agent.
```

### ui install

```text
ark ui install [--port <number>]

Writes the LaunchAgents dev.ark.proxy and dev.ark.hub in ~/Library/LaunchAgents and loads them (proxy first), so the name proxy (portless proxy start --unprivileged) starts at login and the hub starts at login and restarts after a crash (port 4317 unless --port says otherwise). When portless is found (ARK_PORTLESS, else PATH; it needs Node 24+ on the PATH of the shell that runs install), the hub runs through it as http://ark.localhost and install prints the line '  name:   http://ark.localhost'. When it is not found, install writes no proxy agent, keeps the plain hub, prints 'portless not found: the hub stays at http://127.0.0.1:<port>' and exits 0. A second run with the same settings changes nothing; with a new port or a switch between the two forms it rewrites the plist and reloads. If loading an agent fails, install restores and reloads the previous plist of that agent only (or removes a new plist), reports any reload failure, and exits 1. See docs/how-to/local-names.md.
```

### ui uninstall

```text
ark ui uninstall

Unloads and deletes the LaunchAgents dev.ark.hub and dev.ark.proxy, so the hub stops and neither starts at login. It does not stop the shared portless proxy: that keeps running until you run `portless proxy stop`. It does nothing, and exits 0, when neither agent is installed.
```

<!-- generated:commands:end -->

## Run folder

A run lives at `$ARK_HOME/projects/<project>/runs/<run>/`:

```text
ticket.md          copy of the ticket file
events.ndjson      append-only event log
state.json         derived from the events, rebuilt by any command
evaluation.md      written by the evaluator
strategies.md      written by the run lead (strategy cards)
mockups/           written by the Designer, never in an MR
plan.yml           written by the run lead
plan.md            rendered by ark plan check
workspace/         the workspace mirror
results/           test output and test reports
metrics.json       written by ark retro
retro.md           written by the run lead
```

`workspace/` is a mirror of your workspace. A repo is named by its path relative to the workspace, for example `repos/platform`. A single-repo workspace has one repo, named `.`. For a repo the run touches, `ark worktree create` makes a git worktree on the branch `ark/<ticket id>-<slug>` (slug: the ticket title in lowercase with hyphens, at most 40 characters; the lowest free `-2`, `-3`, ... is added when the name exists locally or on origin) at the same relative path under `workspace/`. Every repo the run does not touch, and every other entry in the workspace root except `.git`, is a symlink to the workspace.

## `evaluation.md` format

The evaluator writes `evaluation.md` in the run folder. `ark evaluation record` reads three headings, `Blockers`, `Risks` and `Surfaces` (any heading level, any case). Each heading is followed by a bullet list. An empty `Blockers` or `Risks` list is valid. `Surfaces` needs at least one of `web_ui`, `cli_output`, `document` and `none`; `none` stands alone. A missing heading or an unknown surface is refused. Other text is ignored. With one or more blockers the phase is `awaiting_criteria` until `gate.answered criteria accept`. `plan.md` lists the risks of the latest evaluation in its Evaluation section.

## `strategies.md` format

The run lead writes `strategies.md` in the run folder, and the Designer adds mockup links. Each card is a level-2 heading `## <id> <title>`, followed by lines `Approach:`, `Interfaces:`, `Tradeoffs:`, `Steps:`, `Mockup:` (links to files in the run folder; leave the line out when no mockup is needed, `Mockup: none` is refused), `Skills:` (UI skills the Designer applied, from `ark ui-skills <run>`; needed on each card in the same case as `Mockup:`, and refused when empty or when it names a skill that command does not list), `Recommended: yes` and, for a single card, `Reason:`. `ark strategy record` reads them. With 2 or more cards exactly one is recommended, and the phase is `awaiting_strategy` until `gate.answered strategy <card id>`. With one card, `plan.md` has a Strategy section with "Only one strategy considered, because <reason>".

## `plan.yml` fields

`plan.yml` lives in the run folder. The run lead writes it, and you can edit it at the plan gate. `ark plan check` validates it.

Top level:

| Field        | Type | Meaning                                       |
| ------------ | ---- | --------------------------------------------- |
| `steps`      | list | The steps of the plan.                        |
| `test_cases` | list | The test cases that prove the criteria.       |
| `design`     | map  | The approach, the interfaces and the example. |

`design` has `interfaces` (required) and two optional fields, `approach` (string) and `example` (string). Each entry in `interfaces` has a `name` and a `callers` list of strings. An interface is a command, a playbook section, an event, a file format or an exported function. `ark plan check` rejects a plan with no `design.interfaces` and an interface with no `callers`; the error names the interface. `plan.md` has a Design section before the steps: the approach, a table of interfaces and callers, and the example in a code block. A missing `approach` or `example` shows as `No approach given.` or `No example given.`

`decisions` is an optional list. Each entry has `id`, `question`, `options` (2 to 4 entries, each with `label` and `tradeoffs`), `recommended` (an option label) and, after the human answers, `chosen` (an option label). `ark plan check` names a decision with the wrong number of options or a `recommended` or `chosen` value that is not an option. `plan.md` shows an open decision as a `:::question` block with "Recommended:", and a decided one with `- [x]` on the chosen option. While one or more decisions have no `chosen` value, the first line of `plan.md` is "N decisions need an answer before approval", where N is the number of open decisions; the line is absent when none is open. `plan.checked` records `open_decisions`, and `ark gate record <run> plan approve` is refused while it is above 0.

Each entry in `steps`:

| Field      | Type             | Meaning                                                                                                                                                                                                                                                                                                    |
| ---------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`       | string           | Name of the step. Other steps refer to it in `needs`.                                                                                                                                                                                                                                                      |
| `role`     | string           | `implementer`, `validator`, or `reviewer`.                                                                                                                                                                                                                                                                 |
| `repo`     | string           | The repo the step works in, as a path relative to the workspace.                                                                                                                                                                                                                                           |
| `harness`  | string           | The agent harness, for example `claude`, `codex`, or `omp`. With `model` it must equal the pair of an entry in `roles` in `ark.yml`; `ark plan check` refuses other pairs.                                                                                                                                 |
| `model`    | string           | The model the harness uses.                                                                                                                                                                                                                                                                                |
| `needs`    | list of step ids | Steps that must finish first. An empty list means the step can start at once.                                                                                                                                                                                                                              |
| `criteria` | list of strings  | The AC the step serves.                                                                                                                                                                                                                                                                                    |
| `skills`   | list of strings  | Optional. UI skills the step applies, from `ark ui-skills <run>`. When the evaluation lists a surface other than `none`, `ark plan check` needs it on at least one step, accepts only skills that command lists, and needs every required skill in a non-empty list. `plan.md` then has a `Skills` column. |

Each entry in `test_cases`:

| Field       | Type            | Meaning                                                   |
| ----------- | --------------- | --------------------------------------------------------- |
| `id`        | string          | Name of the test case.                                    |
| `criterion` | string          | The AC the test case proves.                              |
| `level`     | string          | `integration` or `e2e`.                                   |
| `given`     | list of strings | Context for the test. Required; can be empty.             |
| `when`      | list of strings | Actions in order. Must not be empty.                      |
| `then`      | list of strings | Observable results in order. Must not be empty.           |
| `expected`  | string          | Required EARS sentence: "When ..., the system shall ...". |

`ark plan check` rejects missing or malformed groups, an empty `when` or `then`, a missing `expected`, and any old test-case `steps` field. The error names the test case.

In `plan.md`, each group starts with Given, When or Then, in that order. Later lines in each group start with And. An empty `given` emits no Given line. The unchanged EARS sentence follows the Gherkin block on its own `Expected:` line.

Example:

```yaml
steps:
  - id: core-package
    role: implementer
    repo: repos/shared/packages
    harness: claude
    model: claude-sonnet
    needs: []
    criteria: [CLARA-512-AC1]
  - id: core-package-review
    role: reviewer
    repo: repos/shared/packages
    harness: codex
    model: gpt-codex
    needs: [core-package]
    criteria: [CLARA-512-AC1]
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
design:
  approach: Add a unit field to each exported result.
  interfaces:
    - name: export (exported function)
      callers:
        - report command
  example: |
    result,value,unit
    glucose,5.4,mmol/L
```

## `ark.yml` fields

`ark.yml` lives at `~/.ark/projects/<project>/ark.yml`. It is personal to you. The bootstrap playbook writes it, and every command that needs the project reads it. When a field is wrong, the error names it, for example `ark.yml: suites[1].parser must be one of bun, pytest, behave`.

| Field            | Required | Type    | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------- | -------- | ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `workspace`      | yes      | path    | The absolute path of the workspace directory. It must exist. It is one repo or a meta-repo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ticket_source`  | yes      | string  | Where agents fetch tickets: `local`, `github`, or `jira`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `merge_requests` | no       | string  | `open` (the default) or `none`. With `none` the project is local-only: `ark merge-request open` refuses, `ark worktree sync` never pushes, `ark status` lists the local branches, and the run ends `ark run close <run> handed_off`. An Ark older than this key ignores it and pushes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `repos`          | no       | map     | The base and target branch of a repo, keyed by repo path relative to the workspace, exactly as `ark worktree create` names it: `.` or `repos/a`, with no `./` prefix and no trailing slash. Each value is `{ base: <branch name> }`; an entry with no `base`, or a `base` that is not a non-empty string, makes `ark status` exit 1 and name the key. For a repo with a `base`, `ark worktree create` and `ark worktree anchor` run `git fetch origin <base>` and start the worktree from `origin/<base>`, `ark worktree sync` merges `origin/<base>`, `ark merge-request open` targets `<base>` (`gh pr create --base <base>`, `glab mr create --target-branch <base>`), and `ark worktree cleanup` and `ark workspace sync` use it as the target. A repo with no entry keeps the clone's HEAD as base and the branch `origin/HEAD` names as target. Example: `repos: { repos/app: { base: release/9.1.0 }, repos/lib: { base: main } }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `compose`        | no       | string  | The docker compose command for multi-repo projects, for example `docker compose`. When set, `ark test` runs `<compose> --project-directory <mirror> -p <run-id-lowercase> up -d --wait` before the suites and `... down` after them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `setup`          | no       | string  | A shell command that prepares a new worktree, for example `bun install --frozen-lockfile`. `ark worktree create` runs it with `sh -c` in each new worktree, so the suites find the dependencies. It must be a non-empty string when set. A failure exits 1 and removes the worktree; if the removal fails, the output names what was left behind.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `suites`         | yes      | list    | The test suites. You need at least one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `roles`          | yes      | map     | The default `harness` and `model` for each of `implementer`, `validator`, and `reviewer`. The optional `evaluator` role is needed by `ark evaluation record`. The optional `designer` role is needed by `ark strategy record` when the evaluation lists a surface other than `none`, unless the surface is only `none`, or there is one card and the surface is only `document`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `concurrency`    | no       | integer | The most workers that run at once. It must be 1 or more. The default is 2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `round_budget`   | no       | integer | How many rounds an implementer step may restart before escalation. It must be 0 or more. The default is 2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `gates`          | no       | map     | Who answers each gate. Keys: `criteria`, `strategy`, `plan`, `escalation`; each `human` (the default for a missing key) or `auto`. Any other key or value makes `ark status` exit 1 and name the field. `plan: auto` makes `ark plan check` answer `approve` with `by: auto` when the plan is valid with no open decision. `strategy: auto` makes `ark strategy record` answer with the recommended card. `escalation: auto` makes `ark run step <run> <step> start` answer `one_more_round` with `by: auto` for a spent round budget (in phase `building` or `escalation`, whether or not the last test failed) or a post-MR implementer start, and print `escalation one_more_round by auto (<n> of 2)`. It answers at most 2 times in a run. The third spent budget is refused as without the setting, and the gate waits for the human. It never answers after `escalation.requested` (`ark escalate`). A `--merge` start is answered too, prints `escalation one_more_round by auto (merge, not counted)` and does not count toward the 2. `criteria` is validated and shown only; nothing acts on it yet, so it stays with the human even when set to `auto`. An auto `plan`, `strategy` or `escalation` gate needs no Plannotator review and no relay; the run lead sends Master Chief a `status`, not an `ask`, for an auto `escalation`. `plan` and `strategy` auto, with `criteria` human (and `escalation` human unless it is `auto` too), is the Foundry setup. `gate.answered` records `by: human` or `by: auto`; `ark status <run>`, the hub run detail and `metrics.json` (`gates.auto_answers`) show it. |

Each entry in `suites`:

| Field     | Type   | Meaning                                                                                                      |
| --------- | ------ | ------------------------------------------------------------------------------------------------------------ |
| `name`    | string | Name of the suite. It must be unique.                                                                        |
| `level`   | string | `unit`, `integration`, or `e2e`. A unit suite never proves an AC.                                            |
| `repo`    | string | The repo the suite runs in: a path relative to the workspace, or `.`. The command runs in `<mirror>/<repo>`. |
| `command` | string | The shell command. `{report}` is replaced with an absolute path under the run's `results/` folder.           |
| `parser`  | string | `bun`, `pytest`, or `behave`. It reads the report file and the command output.                               |

Example:

```yaml
workspace: /Users/you/Dev/clara
ticket_source: local
compose: docker compose
setup: bun install --frozen-lockfile && bunx playwright install chromium
suites:
  - name: e2e
    level: e2e
    repo: repos/platform
    command: bun test --reporter=junit --reporter-outfile={report}
    parser: bun
  - name: playwright
    level: e2e
    repo: repos/platform
    command: PLAYWRIGHT_JUNIT_OUTPUT_FILE={report} bunx playwright test --reporter=junit
    parser: bun
roles:
  implementer: { harness: claude, model: claude-sonnet }
  validator: { harness: codex, model: gpt-codex }
  reviewer: { harness: codex, model: gpt-codex }
  evaluator: { harness: codex, model: gpt-codex }
  designer: { harness: claude, model: claude-opus }
concurrency: 2
round_budget: 2
gates:
  plan: auto
  strategy: auto
```

A browser suite runs Playwright Test. Playwright's JUnit reporter writes the test title in `name`, so the `bun` parser reads it unchanged, and `PLAYWRIGHT_JUNIT_OUTPUT_FILE` carries the `{report}` path. The `setup` above also installs Chromium, so each new worktree can run the suite; the download is cached in `~/.cache/ms-playwright`.

A test proves an AC when its name or tags contain the AC id, for example `CLARA-512-AC1`. For each AC, `ark test` reports `passing` when at least one tagged integration or E2E test passed and none failed. It reports `failing` when any tagged test failed, and `missing` when no tagged test ran. An AC with `manual: true` in the run's `ticket.md` is decided by the `manual` gate alone: `manual pending` until a person answers, then `manual ok` or `manual problem`. `ark test` exits 0 only when every other AC is `passing` and every manual AC is `manual ok`.

## Events

`events.ndjson` holds one JSON object for each line: `{ "seq": 1, "time": "<ISO time>", "type": "<type>", "data": { ... } }`. `seq` counts up from 1. Every command checks that an event is allowed in the run's current state before it appends the event, then rewrites `state.json`.

| Type                   | Data                                                                                                                                                         | Written by                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| `run.started`          | `project`, `ticket` (`id`, `title`), `criteria` (ids), `ticket_file`                                                                                         | `ark run start`                                    |
| `criteria.updated`     | `criteria` (ids)                                                                                                                                             | `ark gate record` for the `criteria` gate          |
| `criteria.amended`     | `criterion` (id), `old`, `new`                                                                                                                               | `ark criteria amend`                               |
| `evaluation.recorded`  | `blockers` (strings), `risks` (strings), `surfaces` (strings)                                                                                                | `ark evaluation record`                            |
| `strategy.recorded`    | `count`, `recommended`, `cards` (ids), optional `reason`                                                                                                     | `ark strategy record`                              |
| `plan.checked`         | `valid`, `problems`, `plan_hash`, `steps` (`id`, `role`, `repo`, `needs`, `criteria`), `open_decisions`                                                      | `ark plan check`                                   |
| `gate.answered`        | `gate` (`criteria`, `strategy`, `plan`, `escalation`, `manual`), optional `criterion`, `answer`, `by` (`human` or `auto`), optional `note`, optional `merge` | `ark gate record`; `ark run step ... start` (auto) |
| `escalation.requested` | `reason`                                                                                                                                                     | `ark escalate`                                     |
| `worktree.created`     | `repo`, `path`, `branch`, `base`                                                                                                                             | `ark worktree create`                              |
| `worktree.synced`      | `repo`, `conflict`                                                                                                                                           | `ark worktree sync`                                |
| `step.started`         | `step`, `role`, `repo`, `round`, optional `merge` (true)                                                                                                     | `ark run step ... start`                           |
| `step.finished`        | `step`, `outcome` (`succeeded` or `failed`), optional `merge` (true), optional `not_started` (true: the worker never ran, so the start costs no round)       | `ark run step ... finish`                          |
| `test.completed`       | `passed`, `heads` (commit for each repo), `suites` (`name`, `level`, `passed`), `criteria` (AC id to `passing`, `failing`, `missing`, or `manual …`)         | `ark test`                                         |
| `merge_request.opened` | `repo`, `url`, `number`                                                                                                                                      | `ark merge-request open`                           |
| `run.closed`           | `outcome` (`merged`, `abandoned`, `aborted`, or `handed_off`)                                                                                                | `ark run close`                                    |
