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
```

### run step

```text
ark run step <run> <step> start|finish [--failed] [--merge] [--project <name>]

Records that a plan step started or finished. Use --failed with finish when the step failed. A step can start only after you approve the plan. Use --merge with start to run an implementer step that fixes a sync conflict: it costs no round, and it needs a failed ark worktree sync for the step repo.
```

### run close

```text
ark run close <run> <outcome> [--project <name>]

Closes a run. The outcome is merged, abandoned, aborted or handed_off. Ark refuses an outcome that does not fit the run, such as merged with no MRs.
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

Reads strategies.md in the run folder and records its strategy cards: the count, the recommended card and the card IDs. It refuses a missing file, a card with no approach, interfaces or tradeoffs, a mockup link to a file that is not in the run folder, a run with no evaluation record, one card with no reason, and, when the evaluation lists a surface other than none, a card with no mockup link or a project whose ark.yml has no roles.designer. A mockup and roles.designer are not needed when the surface is only none, or when there is one card and the surface is only document. Two or more cards open the strategy gate; one card opens no gate.
```

### plan check

```text
ark plan check <run> [--project <name>]

Checks plan.yml in the run folder and renders plan.md. It prints one line for each problem and exits 1 when the plan is invalid. A plan with no summary is invalid, and so is a decision with fewer than 2 or more than 4 options. It refuses a run with no strategy record or with an open strategy gate. It records the number of open decisions.
```

### worktree create

```text
ark worktree create <run> [<repo>...] [--project <name>]

Builds the run's workspace mirror. Each named repo, or every repo the plan uses, gets a worktree. Every other path is a symlink to the workspace. When `ark.yml` sets `setup`, the command runs it with `sh -c` in each new worktree. If `setup` exits non-zero, the command removes that worktree and its branch, prints the repo, the exit code and the last 10 lines of stderr (of stdout when stderr is empty), and exits 1. If the removal fails, the output names each `left behind` worktree path and branch. It records the worktree only after `setup` passes. A repo folder with a `.git` and no recorded worktree is a stale leftover: the next create removes it, then runs `setup` again.
```

### test

```text
ark test <run> [--project <name>]

Runs the project's suites on the run's workspace mirror and records which ACs have a passing test. It exits 1 unless every AC passes.
```

### gate record

```text
ark gate record <run> <gate> <answer> [--note <text>] [--project <name>]

Records your answer to a gate. The gates are criteria, strategy, plan and escalation. The strategy gate takes the ID of a card in the latest strategy record, or abort. Ark refuses an answer that the run's state does not allow, and refuses plan approve while the plan has an open decision.
```

### escalate

```text
ark escalate <run> --reason <text> [--project <name>]

Opens the escalation gate when the round budget is spent, also when the last ark test passed. Use it for an unresolved review P0 or P1. It records escalation.requested with the reason. It refuses a run that is not in phase building, a round budget that is not spent, and an empty reason. Answer the gate with ark gate record.
```

### merge-request open

```text
ark merge-request open <run> [--project <name>]

Pushes each repo's branch and opens one MR for each repo, in dependency order. No command merges.
```

### merge-request status

```text
ark merge-request status <run> [--project <name>]

Prints each MR of the run as merged, open or closed, read from gh or glab. For open MRs, it also prints `checks failing` and failed check or job names. Check retrieval errors fail the command. It changes nothing.
```

### worktree sync

```text
ark worktree sync <run> [--project <name>]

Fetches and merges origin's target branch into each worktree of the run, and pushes the branch of each repo that has an MR. It records worktree.synced for each repo. On a conflict it records it, undoes the merge and goes on to the next repo. After the last repo it exits 1 and names every conflicting repo. A closed run gets a phase error and its worktrees stay unchanged. It never merges an MR.
```

### workspace sync

```text
ark workspace sync <run> [--project <name>]

Fetches and fast-forwards the target branch of the workspace checkout of each repo the run touched. It exits 1 and names the repo when git refuses, for example on a conflicting local change. It prints repo, branch and head.
```

### status

```text
ark status [<run>] [--project <name>]

Prints the state of one run: phase, round, first unfinished step, waiting gate, last test, MRs and cost. Without a run, it lists every open run. --project limits the config check to one project, like ARK_PROJECT, and with a run it looks for the run in that project only.
```

### retro

```text
ark retro <run> [--project <name>]

Computes the run's cost, time, rework and intervention metrics and writes metrics.json. The `rework` object holds `rounds` (highest round of a non-merge step), `escalations` (escalation gate answers) and `findings_sent_back` (lines in each `findings/round-<n>.md` file that start, after optional `#` marks, one list marker (`N.`, `-` or `*`) and bold marks, with `P0`, `P1`, `P2` or `P3`; no findings folder counts 0). `rework.merge_steps` counts steps started with `--merge`.
```

### chief state

```text
ark chief state [--project <name>]

Prints a Markdown snapshot of Master Chief's state, read live from its sources and never from a file: open runs with phase and current step, run leads (live ones only, dispatch and terminal) from `orca orchestration worker-list`, which reads Master Chief's own Orca Run; `task-list` reads the same Run for the queue, queued Orca Tasks (`ready` and `pending`), the head of the workspace's main branch, `gates` and `concurrency` from ark.yml, closed runs with an empty Close check and free disk space. A source that fails prints `unavailable: <reason>` under its heading, and the other sections still print. An empty source prints `none`. --project falls back to ARK_PROJECT.
```

### chief handover

```text
ark chief handover [--project <name>]

Starts a new Master Chief for the project with `orca agent launch --surface terminal`, using `roles.chief` from ark.yml, and prints the new terminal handle. The prompt names the old Master Chief terminal (found with the live Master Chief of the project), tells the agent to wait until that terminal is gone, and then to run `run-use` on the existing Master Chief Run. It never closes the old terminal: Master Chief does that after the command returns. It exits 1 and starts nothing when no live Master Chief exists, when Orca does not answer or when `roles.chief` is not set. --project falls back to ARK_PROJECT.
```

### ui

```text
ark ui [--port <number>]

Serves the hub on 127.0.0.1, port 4317 unless --port says otherwise. The page is a React app that Bun bundles. The server reads Ark's files every second and Orca and Plannotator every 3 seconds, each with a hard timeout, and pushes changes over Server-Sent Events. Home shows what needs you (oldest first), live runs, Master Chief per project and the agents. A live agent terminal (of an open run or not; the run is empty for an agent Ark did not start) whose last 3 output lines show a provider usage-limit or rate-limit error is a `usage_limit` Needs-me item (id `limit:<run>:<terminal>`, field `limit: {provider, reset_at}`; `reset_at` is null when the output gives no wait time). Home shows a countdown to `reset_at`, and the action switches Orca to the agent terminal. The item goes when the error leaves the output or the agent exits; a failed read keeps it. Keys: j/k move, Enter opens, an item's action key runs its action, Cmd-K opens the palette, ? the shortcut sheet, z focus mode, Esc closes. A view bar switches views (keys 1 Home, 2 Map, 3 Timeline). Map: a graph of project, Master Chief, run, step, agent and MR with a needs-you badge on each node that waits for you; click a node or badge, or press j/k, to light its path; v turns dimming of the other nodes on or off; [ and ] step the replay to the previous or next event since your last visit and l returns to live; Map shares its selection with Home. Timeline: one lane for each Master Chief, run and standalone agent; w cycles the window 12h, 24h, 1h; b shows the cost burn, where a bucket with no provider cost shows ?; a click on a waiting gate block runs the action of its item; Timeline keeps its own selection. Time with no history shows UNAVAILABLE. Both views stop pulses under prefers-reduced-motion. Endpoints: GET /api/state and /api/events (SSE) feed Home; GET /api/map?at=<ISO time> returns {at, replay:{from?,to,events}, nodes:[{id,kind,label,state,needs_you}], edges:[[from,to]]} with state not_started, unavailable or unknown where nothing is known; GET /api/timeline?hours=1|12|24 returns {hours, lanes:[{id,kind,label,segments:[{kind,from,to|null,item?,state?}],cost:{usd,series:[{at,usd}]}}]} and refuses any other hours with 400. History: the hub appends to $ARK_HOME/hub/history.ndjson, one JSON object a line: collector.started when the hub starts, collector.tick each minute, and state.changed {time,key,state,activity?} when an agent (key agent:<run>:<terminal>), a Master Chief (chief:<project>) or the CI of an MR (ci:<MR url>) changes; a refresh with no change writes nothing, and time before the first start or between the last tick and the next start is unavailable. POST actions open an Orca terminal, a Plannotator review or the Inbox, or an MR URL, and steer by typing one line into an Orca terminal with `orca terminal send`: a free message or a fixed instruction (approve and queue, reorder queue, pause, resume, retry stuck agent, and abort after a confirm dialog) to the project's live Master Chief (the connected coordinator of the Orca Run "Master Chief: <project> tickets" in the project workspace), and a free message to a run's lead. The server picks the terminal and the hub never changes run state; with no live Master Chief it returns 409 and sends nothing. Approve and queue takes a list of proposed ticket ids and answers 400 otherwise; the Master Chief box confirms the list first. A project with no live Master Chief shows Spawn Master Chief, which opens a terminal that runs `/skill:ark chief` with `roles.chief` from ark.yml and switches Orca to it. The server refuses a foreign Origin and any unknown action. ARK_NOW=<ISO instant> freezes the hub clock, for reproducible demos and bug reports.
```

### ui install

```text
ark ui install [--port <number>]

Writes the LaunchAgent dev.ark.hub in ~/Library/LaunchAgents and loads it, so the hub starts at login and restarts after a crash (port 4317 unless --port says otherwise). The hub sends a macOS notification for each new Needs-me item through terminal-notifier (or the command in ARK_NOTIFIER), and a click opens the hub at that item. Install refuses, and writes nothing, when terminal-notifier is missing: run brew install terminal-notifier. A second run with the same settings changes nothing; with a new port it rewrites the plist and reloads. If loading an update fails, install restores and reloads the previous plist, reports any reload failure, and exits 1. If loading a new install fails, it removes the new plist and exits 1.
```

### ui uninstall

```text
ark ui uninstall

Unloads and deletes the LaunchAgent dev.ark.hub. It does nothing, and exits 0, when the agent is not installed. The notification history in ~/.ark/hub/notifications.ndjson is kept.
```

<!-- generated:commands:end -->

### Run detail API

`GET /api/runs/<run>` returns one run's detail as JSON (404 for an unknown run). The pushed state also carries `details`, the same object for each open run, rebuilt every 3 seconds. Fields:

| Field                              | Content                                                                                                                                                                                                                                                                                |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `timeline`                         | `{phase, at}` for each phase change in `events.ndjson`                                                                                                                                                                                                                                 |
| `gates`                            | `{gate, asked, answered, answer, wait_seconds}`; an open gate has `answered: null` and waits until now                                                                                                                                                                                 |
| `rounds`                           | `{round, at, steps}` from `step.started`, merge steps skipped                                                                                                                                                                                                                          |
| `steps`                            | each plan step with `status`, `cost` and `wall_seconds`                                                                                                                                                                                                                                |
| `ac_proof`                         | the latest `test.completed`: each AC with its status and test cases (`name`, `status`, `suite`, `report`). Cases come from the `results/` reports; a missing or unreadable report gives a case with `status: "unavailable"`, never a pass. `not available` before the first `ark test` |
| `cost`                             | `{usd, tokens}` for the run, and for each step and agent. It uses the readers and the step assignment of `ark retro`; a cost that cannot be measured is `"unknown"`, never 0                                                                                                           |
| `agents`                           | each Orca agent of the run with `cost`, `wall_seconds` and `output`: the last 20 lines from `orca terminal read` (2 second timeout), or `"unknown"` when the agent is not live or the read fails                                                                                       |
| `time_split`                       | seconds in `working`, `waiting_human` (an open gate), `waiting_ci_or_paused`, `stalled` and `unavailable`; the parts add up to `wall_seconds`. Time before the first `history.ndjson` line is `unavailable` unless a gate was open                                                     |
| `plan`, `evaluation`, `strategies` | `{state: "ok", ...}` (`plan.html` is the rendered `plan.md`; `evaluation` has `blockers`, `risks`, `surfaces`; `strategies.cards` has each card with its `mockups` links), or `{state: "not available"}` when the file is missing                                                      |

## Run folder

A run lives at `$ARK_HOME/projects/<project>/runs/<run>/`:

```text
ticket.md          copy of the ticket file
events.ndjson      append-only event log
state.json         derived from the events, rebuilt by any command
history.ndjson     written by the hub only: timestamped changes of MR CI state and agent liveness
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

`workspace/` is a mirror of your workspace. A repo is named by its path relative to the workspace, for example `repos/platform`. A single-repo workspace has one repo, named `.`. For a repo the run touches, `ark worktree create` makes a git worktree on the branch `ark/<ticket id>-<slug>` (slug: the ticket title in lowercase with hyphens, at most 40 characters; `-<run number>` is added from the second run) at the same relative path under `workspace/`. Every repo the run does not touch, and every other entry in the workspace root except `.git`, is a symlink to the workspace.

`history.ndjson` holds one JSON line per change: `{"time","kind","subject","state"}`. `kind` is `ci` (subject: the MR URL; state: `pending`, `passing` or `failing`, read from `gh` or `glab` with a 5 second timeout; a failed read writes nothing) or `liveness` (subject: the terminal handle; state: `live`, `stuck`, `dead`, `exited`, `paused` or `unknown`). Orca has no run-level pause flag, so a pause shows as the `paused` verdict. The hub appends a line only when a state differs from the last line for the same kind and subject. Time before the first line is unavailable and is never counted as zero. `ark retro` and the event log do not read it.

## `evaluation.md` format

The evaluator writes `evaluation.md` in the run folder. `ark evaluation record` reads three headings, `Blockers`, `Risks` and `Surfaces` (any heading level, any case). Each heading is followed by a bullet list. An empty `Blockers` or `Risks` list is valid. `Surfaces` needs at least one of `web_ui`, `cli_output`, `document` and `none`; `none` stands alone. A missing heading or an unknown surface is refused. Other text is ignored. With one or more blockers the phase is `awaiting_criteria` until `gate.answered criteria accept`. `plan.md` lists the risks of the latest evaluation in its Evaluation section.

## `strategies.md` format

The run lead writes `strategies.md` in the run folder, and the Designer adds mockup links. Each card is a level-2 heading `## <id> <title>`, followed by lines `Approach:`, `Interfaces:`, `Tradeoffs:`, `Steps:`, `Mockup:` (links to files in the run folder; leave the line out when no mockup is needed, `Mockup: none` is refused), `Recommended: yes` and, for a single card, `Reason:`. `ark strategy record` reads them. With 2 or more cards exactly one is recommended, and the phase is `awaiting_strategy` until `gate.answered strategy <card id>`. With one card, `plan.md` has a Strategy section with "Only one strategy considered, because <reason>".

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

| Field      | Type             | Meaning                                                                       |
| ---------- | ---------------- | ----------------------------------------------------------------------------- |
| `id`       | string           | Name of the step. Other steps refer to it in `needs`.                         |
| `role`     | string           | `implementer`, `validator`, or `reviewer`.                                    |
| `repo`     | string           | The repo the step works in, as a path relative to the workspace.              |
| `harness`  | string           | The agent harness, for example `claude`, `codex`, `omp`, or `pi`.             |
| `model`    | string           | The model the harness uses.                                                   |
| `needs`    | list of step ids | Steps that must finish first. An empty list means the step can start at once. |
| `criteria` | list of strings  | The AC the step serves.                                                       |

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

| Field           | Required | Type    | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------- | -------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace`     | yes      | path    | The absolute path of the workspace directory. It must exist. It is one repo or a meta-repo.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `ticket_source` | yes      | string  | Where agents fetch tickets: `local`, `github`, or `jira`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `compose`       | no       | string  | The docker compose command for multi-repo projects, for example `docker compose`. When set, `ark test` runs `<compose> --project-directory <mirror> -p <run-id-lowercase> up -d --wait` before the suites and `... down` after them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `setup`         | no       | string  | A shell command that prepares a new worktree, for example `bun install --frozen-lockfile`. `ark worktree create` runs it with `sh -c` in each new worktree, so the suites find the dependencies. It must be a non-empty string when set. A failure exits 1 and removes the worktree; if the removal fails, the output names what was left behind.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `suites`        | yes      | list    | The test suites. You need at least one.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `roles`         | yes      | map     | The default `harness` and `model` for each of `implementer`, `validator`, and `reviewer`. The optional `evaluator` role is needed by `ark evaluation record`. The optional `designer` role is needed by `ark strategy record` when the evaluation lists a surface other than `none`, unless the surface is only `none`, or there is one card and the surface is only `document`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `concurrency`   | no       | integer | The most workers that run at once. It must be 1 or more. The default is 2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `round_budget`  | no       | integer | How many rounds an implementer step may restart before escalation. It must be 0 or more. The default is 2.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `gates`         | no       | map     | Who answers each gate. Keys: `criteria`, `strategy`, `plan`, `escalation`; each `human` (the default for a missing key) or `auto`. Any other key or value makes `ark status` exit 1 and name the field. `plan: auto` makes `ark plan check` answer `approve` with `by: auto` when the plan is valid with no open decision. `strategy: auto` makes `ark strategy record` answer with the recommended card. `criteria` and `escalation` are validated and shown only; nothing acts on them yet, so they stay with the human even when set to `auto`. An auto `plan` or `strategy` gate needs no Plannotator review and no relay. `plan` and `strategy` auto, with `criteria` and `escalation` human, is the Foundry setup. `gate.answered` records `by: human` or `by: auto`; `ark status <run>`, the hub run detail and `metrics.json` (`gates.auto_answers`) show it. |

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

A test proves an AC when its name or tags contain the AC id, for example `CLARA-512-AC1`. For each AC, `ark test` reports `passing` when at least one tagged integration or E2E test passed and none failed. It reports `failing` when any tagged test failed, and `missing` when no tagged test ran.

## Events

`events.ndjson` holds one JSON object for each line: `{ "seq": 1, "time": "<ISO time>", "type": "<type>", "data": { ... } }`. `seq` counts up from 1. Every command checks that an event is allowed in the run's current state before it appends the event, then rewrites `state.json`.

| Type                   | Data                                                                                                                                     | Written by                                |
| ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `run.started`          | `project`, `ticket` (`id`, `title`), `criteria` (ids), `ticket_file`                                                                     | `ark run start`                           |
| `criteria.updated`     | `criteria` (ids)                                                                                                                         | `ark gate record` for the `criteria` gate |
| `criteria.amended`     | `criterion` (id), `old`, `new`                                                                                                           | `ark criteria amend`                      |
| `evaluation.recorded`  | `blockers` (strings), `risks` (strings), `surfaces` (strings)                                                                            | `ark evaluation record`                   |
| `strategy.recorded`    | `count`, `recommended`, `cards` (ids), optional `reason`                                                                                 | `ark strategy record`                     |
| `plan.checked`         | `valid`, `problems`, `plan_hash`, `steps` (`id`, `role`, `repo`, `needs`, `criteria`), `open_decisions`                                  | `ark plan check`                          |
| `gate.answered`        | `gate` (`criteria`, `strategy`, `plan`, or `escalation`), `answer`, optional `note`                                                      | `ark gate record`                         |
| `escalation.requested` | `reason`                                                                                                                                 | `ark escalate`                            |
| `worktree.created`     | `repo`, `path`, `branch`, `base`                                                                                                         | `ark worktree create`                     |
| `worktree.synced`      | `repo`, `conflict`                                                                                                                       | `ark worktree sync`                       |
| `step.started`         | `step`, `role`, `repo`, `round`, optional `merge` (true)                                                                                 | `ark run step ... start`                  |
| `step.finished`        | `step`, `outcome` (`succeeded` or `failed`), optional `merge` (true)                                                                     | `ark run step ... finish`                 |
| `test.completed`       | `passed`, `heads` (commit for each repo), `suites` (`name`, `level`, `passed`), `criteria` (AC id to `passing`, `failing`, or `missing`) | `ark test`                                |
| `merge_request.opened` | `repo`, `url`, `number`                                                                                                                  | `ark merge-request open`                  |
| `run.closed`           | `outcome` (`merged`, `abandoned`, `aborted`, or `handed_off`)                                                                            | `ark run close`                           |
