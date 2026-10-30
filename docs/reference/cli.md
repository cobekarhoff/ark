# Command reference

This page describes the `ark` CLI. The command section is generated from `ark --help` by `scripts/cli-reference.ts`. Run `bun scripts/cli-reference.ts` after you change a help text. The sections after it are written by hand.

Every command except `ark run start` takes a run id. `ark` finds the run by scanning `$ARK_HOME/projects/*/runs/<run>`. `ARK_HOME` defaults to `~/.ark`. A run id looks like `2026-10-29-CLARA-512-1`: the date, the ticket id, and the next free number for that ticket and date.

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
ark run step <run> <step> start|finish [--failed]

Records that a plan step started or finished. Use --failed with finish when the step failed. A step can start only after you approve the plan.
```

### run close

```text
ark run close <run> <outcome>

Closes a run. The outcome is merged, abandoned, aborted or handed_off. Ark refuses an outcome that does not fit the run, such as merged with no MRs. After it records the outcome, it removes each worktree of the run and deletes its local branch. It keeps a worktree that has uncommitted changes, and for a merged run a branch that is not in the target branch, and prints the repo and the reason.
```

### plan check

```text
ark plan check <run>

Checks plan.yml in the run folder and renders plan.md. It prints one line for each problem and exits 1 when the plan is invalid. A plan with no summary block (`summary.why` and `summary.changes` with `criterion`, `where`, `now`, `fix`) is invalid.
```

### worktree create

```text
ark worktree create <run> [<repo>...]

Builds the run's workspace mirror. Each named repo, or every repo the plan uses, gets a worktree. Every other path is a symlink to the workspace.
```

### worktree sync

```text
ark worktree sync <run>

Fetches and merges origin's target branch into each worktree of the run, and pushes the branch of each repo that has an MR. On a conflict it undoes the merge, names the repo and exits 1. It never merges an MR.
```

### workspace sync

```text
ark workspace sync <run>

Fetches and fast-forwards the target branch of the workspace checkout of each repo the run touched. It exits 1 and names the repo when git refuses, for example on a conflicting local change. It prints repo, branch and head.
```

### test

```text
ark test <run>

Runs the project's suites on the run's workspace mirror and records which ACs have a passing test. It exits 1 unless every AC passes.
```

### gate record

```text
ark gate record <run> <gate> <answer> [--note <text>]

Records your answer to a gate. The gates are criteria, plan and escalation. Ark refuses an answer that the run's state does not allow.
```

### merge-request open

```text
ark merge-request open <run>

Pushes each repo's branch and opens one MR for each repo, in dependency order. No command merges.
```

### merge-request status

```text
ark merge-request status <run>

Prints each MR of the run as merged, open or closed, read from gh or glab. It changes nothing.
```

### status

```text
ark status [<run>] [--project <name>]

Prints the state of one run: phase, round, first unfinished step, waiting gate, last test, MRs and cost. Without a run, it lists every open run. --project limits the config check to one project, like ARK_PROJECT.
```

### retro

```text
ark retro <run>

Computes the run's cost, time, rework and intervention metrics and writes metrics.json.
```

<!-- generated:commands:end -->

## Run folder

A run lives at `$ARK_HOME/projects/<project>/runs/<run>/`:

```text
ticket.md          copy of the ticket file
events.ndjson      append-only event log
state.json         derived from the events, rebuilt by any command
plan.yml           written by the run lead
plan.md            rendered by ark plan check
workspace/         the workspace mirror
results/           test output and test reports
metrics.json       written by ark retro
retro.md           written by the run lead
```

`workspace/` is a mirror of your workspace. A repo is named by its path relative to the workspace, for example `repos/platform`. A single-repo workspace has one repo, named `.`. For a repo the run touches, `ark worktree create` makes a git worktree on the branch `ark/<ticket id>-<slug>` (slug: the ticket title in lowercase with hyphens, at most 40 characters; `-<run number>` is added from the second run) at the same relative path under `workspace/`. Every repo the run does not touch, and every other entry in the workspace root except `.git`, is a symlink to the workspace.

## `plan.yml` fields

`plan.yml` lives in the run folder. The run lead writes it, and you can edit it at the plan gate. `ark plan check` validates it.

Top level:

| Field | Type | Meaning |
| --- | --- | --- |
| `steps` | list | The steps of the plan. |
| `test_cases` | list | The test cases that prove the criteria. |

Each entry in `steps`:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Name of the step. Other steps refer to it in `needs`. |
| `role` | string | `implementer`, `validator`, or `reviewer`. |
| `repo` | string | The repo the step works in, as a path relative to the workspace. |
| `harness` | string | The agent harness, for example `claude`, `codex`, `omp`, or `pi`. |
| `model` | string | The model the harness uses. |
| `needs` | list of step ids | Steps that must finish first. An empty list means the step can start at once. |
| `criteria` | list of strings | The AC the step serves. |

Each entry in `test_cases`:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Name of the test case. |
| `criterion` | string | The AC the test case proves. |
| `level` | string | `integration` or `e2e`. |
| `steps` | list of strings | What the test does, in order. |
| `expected` | string | What must be true at the end. |

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
    steps:
      - Export a result that has a unit.
    expected: The exported file lists the unit.
```

## `ark.yml` fields

`ark.yml` lives at `~/.ark/projects/<project>/ark.yml`. It is personal to you. The bootstrap playbook writes it, and every command that needs the project reads it. When a field is wrong, the error names it, for example `ark.yml: suites[1].parser must be one of bun, pytest, behave`.

| Field | Required | Type | Meaning |
| --- | --- | --- | --- |
| `workspace` | yes | path | The absolute path of the workspace directory. It must exist. It is one repo or a meta-repo. |
| `ticket_source` | yes | string | Where agents fetch tickets: `local`, `github`, or `jira`. |
| `compose` | no | string | The docker compose command for multi-repo projects, for example `docker compose`. When set, `ark test` runs `<compose> --project-directory <mirror> -p <run-id-lowercase> up -d --wait` before the suites and `... down` after them. |
| `suites` | yes | list | The test suites. You need at least one. |
| `roles` | yes | map | The default `harness` and `model` for each of `implementer`, `validator`, and `reviewer`. |
| `concurrency` | no | integer | The most workers that run at once. It must be 1 or more. The default is 2. |
| `round_budget` | no | integer | How many rounds an implementer step may restart before escalation. It must be 0 or more. The default is 2. |

Each entry in `suites`:

| Field | Type | Meaning |
| --- | --- | --- |
| `name` | string | Name of the suite. It must be unique. |
| `level` | string | `unit`, `integration`, or `e2e`. A unit suite never proves an AC. |
| `repo` | string | The repo the suite runs in: a path relative to the workspace, or `.`. The command runs in `<mirror>/<repo>`. |
| `command` | string | The shell command. `{report}` is replaced with an absolute path under the run's `results/` folder. |
| `parser` | string | `bun`, `pytest`, or `behave`. It reads the report file and the command output. |

Example:

```yaml
workspace: /Users/you/Dev/clara
ticket_source: local
compose: docker compose
suites:
  - name: e2e
    level: e2e
    repo: repos/platform
    command: bun test --reporter=junit --reporter-outfile={report}
    parser: bun
roles:
  implementer: { harness: claude, model: claude-sonnet }
  validator: { harness: codex, model: gpt-codex }
  reviewer: { harness: codex, model: gpt-codex }
concurrency: 2
round_budget: 2
```

A test proves an AC when its name or tags contain the AC id, for example `CLARA-512-AC1`. For each AC, `ark test` reports `passing` when at least one tagged integration or E2E test passed and none failed. It reports `failing` when any tagged test failed, and `missing` when no tagged test ran.

## Events

`events.ndjson` holds one JSON object for each line: `{ "seq": 1, "time": "<ISO time>", "type": "<type>", "data": { ... } }`. `seq` counts up from 1. Every command checks that an event is allowed in the run's current state before it appends the event, then rewrites `state.json`.

| Type | Data | Written by |
| --- | --- | --- |
| `run.started` | `project`, `ticket` (`id`, `title`), `criteria` (ids), `ticket_file` | `ark run start` |
| `criteria.updated` | `criteria` (ids) | `ark gate record` for the `criteria` gate |
| `plan.checked` | `valid`, `problems`, `plan_hash`, `steps` (`id`, `role`, `repo`, `needs`, `criteria`) | `ark plan check` |
| `gate.answered` | `gate` (`criteria`, `plan`, or `escalation`), `answer`, optional `note` | `ark gate record` |
| `worktree.created` | `repo`, `path`, `branch`, `base` | `ark worktree create` |
| `step.started` | `step`, `role`, `repo`, `round` | `ark run step ... start` |
| `step.finished` | `step`, `outcome` (`succeeded` or `failed`) | `ark run step ... finish` |
| `test.completed` | `passed`, `heads` (commit for each repo), `suites` (`name`, `level`, `passed`), `criteria` (AC id to `passing`, `failing`, or `missing`) | `ark test` |
| `merge_request.opened` | `repo`, `url`, `number` | `ark merge-request open` |
| `run.closed` | `outcome` (`merged`, `abandoned`, `aborted`, or `handed_off`) | `ark run close` |
