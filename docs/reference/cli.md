# Command reference

This page becomes generated from `ark --help` in ARK-157. Until then, it is the planned interface, written by hand. The commands below are not built yet. The code in `cli/` still follows the old design. Command names, arguments, and field names are final when the ticket named under each command lands.

Every command works on one project. `ark` finds the project from your workspace. Commands print one result and exit 0 on success. On failure, a command prints the reason and exits 1.

## Commands

### `ark run start`

```sh
ark run start <ticket-file>
```

Starts a run. It copies the ticket file that an agent wrote into a new run folder, creates the event log and the derived state, and prints the run name. The command fetches nothing from a ticket source.

- **Writes:** `runs/<run>/ticket.md`, `events.ndjson`, `state.json`.
- **Exit:** 0 when the run starts. 1 when the file is missing or the ticket already has an open run.
- **Ticket:** ARK-152.

### `ark plan check`

```sh
ark plan check <run>
```

Validates `plan.yml` and renders `plan.mmd`. The check fails on a cycle, an unknown `needs`, a step with no repo or role, and a criterion with no integration or end-to-end test case.

- **Writes:** `plan.mmd`.
- **Exit:** 0 when the plan is valid. 1 with one line per problem.
- **Ticket:** ARK-153.

### `ark worktree create`

```sh
ark worktree create <run> [<repo>...]
```

Creates a worktree for each named repo, or for every repo the plan uses, side by side under `repos/<name>/` in the run folder.

- **Writes:** `repos/<name>/` and a `worktree.created` event for each repo.
- **Exit:** 0 when every worktree exists. 1 when a repo is unknown or git fails.
- **Ticket:** ARK-154.

### `ark test`

```sh
ark test <run>
```

Runs the project's integration and end-to-end suites on the composed workspace. For a multi-repo run, it first writes a docker compose override that points at the run's worktrees. Each suite's parser maps native tags to results for each acceptance criterion.

- **Writes:** `results/`, the compose override, and test events.
- **Exit:** 0 when every criterion has a passing tagged test at head. 1 otherwise, with the failing criteria listed.
- **Ticket:** ARK-154. The pytest and behave parsers come with ARK-158.

### `ark gate record`

```sh
ark gate record <run> <gate> <answer>
```

Records your answer to a gate. `<gate>` is `criteria`, `plan`, or `escalation`. The run lead runs this command after you answer in Master Chief's session or in Plannotator. Escalation answers are `one_more_round`, `take_over`, and `abort`. The accepted answers for the other gates are final in ARK-153.

- **Writes:** a gate event, and the state that follows it.
- **Exit:** 0 when the answer is legal for the gate in the run's current state. 1 otherwise, for example for a plan answer before a plan exists.
- **Ticket:** ARK-153.

### `ark merge-request open`

```sh
ark merge-request open <run>
```

Pushes each repo's branch and opens one merge request per repo in dependency order. On GitHub, it opens a pull request. It records dependencies with a merge request dependency on GitLab where the tier allows it, and with `Depends on !N` in the description otherwise. On GitHub, it writes `Depends on #N`. No command merges.

- **Writes:** merge request events with the URL for each repo.
- **Exit:** 0 when every repo has a merge request. 1 when a push or an open fails.
- **Ticket:** ARK-155.

### `ark status`

```sh
ark status [<run>]
```

Prints the state of one run, or of every open run in the project. It shows the current step, the round, any gate that waits for you, and the cost so far.

- **Writes:** nothing.
- **Exit:** 0. 1 when the run is unknown.
- **Ticket:** ARK-152.

### `ark run close`

```sh
ark run close <run> <outcome>
```

Closes a run with an outcome: `merged`, `abandoned`, `aborted`, or `handed_off`. Master Chief checks the state of the merge requests with `gh` or `glab` before it calls this command.

- **Writes:** a `run.closed` event and the final state.
- **Exit:** 0 when the run closes. 1 when the outcome does not fit the run, for example `merged` with no merge requests.
- **Ticket:** ARK-152.

### `ark retro`

```sh
ark retro <run>
```

Computes the run's cost, time, rework, human intervention, and orchestration health. It compares them with earlier runs of the same project.

- **Writes:** `metrics.json`. The run lead writes `retro.md` on top of it.
- **Exit:** 0 when `metrics.json` is written. 1 when the run has no events or a session file cannot be read.
- **Ticket:** ARK-160.

## `plan.yml` fields

`plan.yml` lives in the run folder. The run lead writes it, and you can edit it at the plan gate. `ark plan check` validates it. ARK-153 makes these field names final.

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
| `repo` | string | The repo the step works in. |
| `harness` | string | The agent harness, for example `claude`, `codex`, `omp`, or `pi`. |
| `model` | string | The model the harness uses. |
| `needs` | list of step ids | Steps that must finish first. An empty list means the step can start at once. |
| `criteria` | list of strings | The acceptance criteria the step serves. |

Each entry in `test_cases`:

| Field | Type | Meaning |
| --- | --- | --- |
| `id` | string | Name of the test case. |
| `criterion` | string | The acceptance criterion the test case proves. |
| `level` | string | `integration` or `e2e`. |
| `steps` | list of strings | What the test does, in order. |
| `expected` | string | What must be true at the end. |

Example:

```yaml
steps:
  - id: core-package
    role: implementer
    repo: shared/packages
    harness: claude
    model: claude-sonnet
    needs: []
    criteria: [CLARA-512-AC1]
  - id: core-package-review
    role: reviewer
    repo: shared/packages
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

`ark.yml` lives at `~/.ark/projects/<project>/ark.yml`. It is personal to you. The bootstrap playbook writes it in ARK-158, and ARK-152 reads it. These field names are final when ARK-152 lands.

| Field | Type | Meaning |
| --- | --- | --- |
| `workspace` | path | The workspace directory. It is one repo or a meta-repo. |
| `ticket_source` | string | Where agents fetch tickets: local markdown, GitHub issues, or Jira. |
| `compose` | string | The docker compose command for multi-repo projects. |
| `suites` | list | The integration and end-to-end suites. Each has a `name`, a `level`, a `command`, and a `parser`. |
| `roles` | map | The default `harness` and `model` for each of `implementer`, `validator`, and `reviewer`. |
| `concurrency` | number | The most runs or workers that run at once. |
| `round_budget` | number | How many rounds a run may use before escalation. The default is 2. |
