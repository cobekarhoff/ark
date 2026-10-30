# Bootstrap playbook

You teach Ark one project. You run as Master Chief, in an Orca terminal. You detect first and ask second. At the end, `~/.ark/projects/<project>/ark.yml` exists, Orca knows every repo, workers can load the workspace's skills, and `ark status` accepts the file.

Inputs: the workspace path (default: the current directory) and the project name (default: the lowercase directory name of the workspace). Use absolute paths everywhere.

You never write product code. You write only `ark.yml` and, in step 7, one OMP setting.

## Rules

- Detect before you ask. Read files and run read-only commands. Never ask the human something a file already answers.
- Ask one question at a time. Give a recommended answer with each question, and wait for the answer before you ask the next. Format: `<question>. Recommended: <answer>, because <reason>.`
- Never overwrite an existing `ark.yml` without the human's answer (step 1).
- Leave anything already registered or configured unchanged, unless the human says to change it.

## 1. Check for an existing project

```sh
test -f ~/.ark/projects/<project>/ark.yml && cat ~/.ark/projects/<project>/ark.yml
```

If the file exists, show it and ask: "`ark.yml` exists for `<project>`. Keep it, replace it, or edit it?" Recommended: keep it, unless the workspace changed. On "keep", jump to step 4 and register what is missing. On "replace" or "edit", continue and write the file in step 8 only after the human's answer.

## 2. Detect the workspace

Do not ask anything in this step.

### Repos

A repo is a directory that holds a `.git` directory or file. List them the way `ark worktree create` does (the workspace itself counts as `.`, nested repos up to 4 levels deep, `node_modules` excluded):

```sh
find <workspace> -maxdepth 5 -name .git -not -path '*/node_modules/*'
```

Strip `/.git` and the workspace prefix to get each repo path, such as `repos/platform` or `repos/shared/packages`. One repo, which is the workspace root, means a single-repo project. Several repos mean a meta-repo.

### Stack

Read these files in each repo root. The first match names the stack.

| File | Stack |
| --- | --- |
| `bun.lock`, `bunfig.toml` | Bun and TypeScript |
| `package.json` | Node (read `scripts.test`) |
| `pyproject.toml`, `uv.lock`, `requirements.txt` | Python |
| `go.mod`, `Cargo.toml` | Go, Rust |

Also read `README.md`, `AGENTS.md`, `CLAUDE.md` and any `Taskfile*`, `Makefile` or `justfile` for the commands the team uses to test.

### Integration and E2E suites

Ark counts only integration and E2E suites as proof of an AC. Unit suites never prove one, so leave them out of `ark.yml`.

For each repo, find test locations and classify them:

- A directory or file name with `e2e`, `end-to-end`, `integration` or `acceptance` marks the level (`e2e` or `integration`). A top-level `test/` directory with only unit-style files is a unit suite: skip it.
- A repo that holds only E2E tests, such as `repos/end-to-end-tests`, is one `e2e` suite.
- Behave suites have a `features/` directory with `.feature` files.

Pick the runner and parser from the files:

| Signal | `parser` | `command` |
| --- | --- | --- |
| `*.test.ts` files, Bun stack | `bun` | `bun test <directory> --reporter=junit --reporter-outfile={report}` |
| `pytest` in `pyproject.toml`, `conftest.py`, or `test_*.py` files | `pytest` | `pytest -o junit_family=xunit1 --junitxml={report} <directory>` |
| `features/` with `.feature` files, `behave` in dependencies | `behave` | `behave --format json -o {report} <directory>` |

If the repo's own tooling wraps the runner (for example `uv run pytest` or `pnpm exec`), put that wrapper in front of the command. `{report}` stays literal: `ark test` replaces it with a path under the run's `results/` folder.

The pytest parser needs the `ac` marker to reach the report. Check that the suite's `conftest.py` has the `pytest_runtest_setup` hook described at the top of `cli/parsers/pytest.ts`. If it does not, note it for the final summary. The validator adds it on the first run.

Each suite needs a unique `name`, a `level` (`integration` or `e2e`), a `repo` (the repo path, or `.`), a `command` and a `parser`.

### Compose command

Look for `docker-compose.yml`, `docker-compose.yaml`, `compose.yml` or `compose.yaml` in the workspace root, then at `Taskfile*`, `Makefile`, `package.json` scripts and the README for how the team starts the stack (`dev:up` in a Taskfile, for instance).

- Compose file at the root with no extra files: `docker compose`.
- The team always layers files or profiles: add them, such as `docker compose -f docker-compose.yml -f docker-compose.dev.yml`.
- Never include `--project-directory` or `-p`. `ark test` adds them and runs `<compose> --project-directory <run>/workspace -p <run-id> up -d --wait`.

Check that the command parses: `docker compose -f <file> config --quiet` (read-only). If no compose file exists, leave `compose` out.

### Ticket source

Choose the first rule that matches:

1. `.mcp.json`, `AGENTS.md`, `CLAUDE.md`, `knowledge/` or the README names Jira (`atlassian`, `jira`, a key such as `CLARA-123`): `jira`.
2. `git remote get-url origin` points at `github.com` and the repo has no other tracker: `github`.
3. A `tickets/` or `docs/tickets/` directory with `.md` files: `local`.

If two rules match with different answers, or none match, the source is unknown: ask in step 3. The remote host alone does not decide: a GitLab remote with Jira in the docs means `jira`.

### Roles

Use this default, which is cross-vendor review (the validator and reviewer run on a different vendor from the implementer):

```yaml
roles:
  implementer: { harness: claude, model: claude-sonnet }
  validator: { harness: codex, model: gpt-codex }
  reviewer: { harness: codex, model: gpt-codex }
```

Run `command -v claude codex omp`. If a harness from the default is missing, the roles are unknown: ask in step 3.

Leave out `concurrency` and `round_budget`. Their defaults are 2 and 2.

## 3. Ask only what you could not detect

Make a list of the unknowns: ticket source, roles, an ambiguous suite level, or a missing suite command. For each unknown, one at a time:

1. Ask the question with a recommended answer.
2. Wait for the human.
3. Record the answer and move to the next.

Example: "I found Jira in `.mcp.json` and a GitLab remote. Which ticket source should Ark use? Recommended: `jira`, because the agents' Jira tools are configured and the GitLab remote only hosts code."

If nothing is unknown, ask nothing and go on.

## 4. Check Orca

Orca hosts every agent, so bootstrap fails fast when it is not ready.

```sh
orca status --json
```

Read `result.runtime.state`. If it is not `ready` and `reachable` is not `true`, stop and tell the human: "Orca is not running. Open the Orca app and start again."

## 5. Register the workspace and each nested repo in Orca

Orca can launch agents into Ark's worktrees only when it lists the repo and shows its non-Orca worktrees.

List what Orca already knows:

```sh
orca repo list --json
```

Each entry in `result.repos` has `id`, `path` and `externalWorktreeVisibility` (`show`, `hide` or `inherit`). For the workspace path and for each repo path from step 2 (absolute, so `<workspace>/<repo>`):

1. **Not registered** (no entry has that `path`):
   ```sh
   orca repo add --path <absolute-path> --json
   orca repo set --repo path:<absolute-path> --external-worktree-visibility show --json
   ```
2. **Registered with `externalWorktreeVisibility` `show`**: leave it unchanged. Do nothing.
3. **Registered with any other visibility**: do not change it on your own. Ask: "`<path>` is registered in Orca but hides worktrees that Orca did not create. Ark's worktrees are such worktrees. Show them? Recommended: yes, because without it Orca cannot launch agents into a run's worktrees." On yes, run the `orca repo set` line above. On no, say that runs cannot launch agents in that repo.

Confirm:

```sh
orca repo list --json
```

Every path must appear with `externalWorktreeVisibility` `show`. Report any path that does not.

## 6. Confirm Orca's nesting depth is at least 2

The chain is Master Chief, run lead, worker. That is depth 2. Orca's default allows depth 1 only, and no CLI reads the setting, so you test it by starting a throwaway chain.

1. Create the test's own Run. `worker-start` needs a Run bound to this terminal, and `run-create` binds it:
   ```sh
   orca orchestration run-create --objective "Ark bootstrap depth check" --json
   ```
   The depth-1 worker and the nested worker start in this Run. Master Chief ignores it, because it uses only its own "Master Chief: <project> tickets" Run.
2. Start a throwaway depth-1 worker in the workspace. It plays the run lead:
   ```sh
   orca orchestration worker-start --agent omp --worktree path:<workspace> --task-title "Ark depth check" --spec "Run this command and nothing else: orca orchestration worker-start --agent omp --worktree path:<workspace> --spec 'Reply done and stop.' --json. Then report the full JSON the command printed. Do not retry." --json
   ```
   Note the dispatch id from the JSON result.
3. Wait for the report, then read it:
   ```sh
   orca orchestration check --wait --timeout-ms 180000 --json
   orca orchestration worker-read --dispatch <dispatch-id> --source transcript --json
   ```
4. Read the depth-1 worker's report.
   - It shows a started nested worker (the JSON has no error): depth is at least 2. Go on.
   - It shows `nested_worker_depth_exceeded`, or "Sub-worker dispatch is not permitted at depth 2 (max 1)": depth is 1. Tell the human exactly: "Open Orca, go to Settings → Orchestration → Nested worker depth, and set it to 2. Then tell me and I will test again." Wait, then repeat from step 2. Do not go on until the test passes.
5. Clean up. Stop both throwaway workers and release their terminals:
   ```sh
   orca orchestration worker-stop --dispatch <dispatch-id> --json
   orca orchestration worker-release --dispatch <dispatch-id> --json
   ```
   Do the same for the nested worker's dispatch if the report names one.

## 7. Make the workspace's skills reachable for workers

Workers run in `<run>/workspace/<repo>` worktrees, and run leads in `<run>/workspace`. Clara's own skills (`.claude/skills`, the `factory-*` skills) sit at the workspace root. The ARK-150 spike found that OMP does not load them from the mirror.

The method that works: add the workspace's skills directory to OMP's `skills.customDirectories` setting. OMP scans each listed directory for `<directory>/<skill-name>/SKILL.md`, one level deep, and requires each `SKILL.md` to have a `description`. A custom directory outranks a default skill with the same name. Because the setting lives in OMP's user configuration, every OMP agent that Orca launches (run leads, workers and subagents) gets the skills, whatever its working directory.

1. Find the directories. Check the workspace root and each repo for `.claude/skills`, `.agents/skills` and `.omp/skills`:
   ```sh
   ls -d <workspace>/.claude/skills <workspace>/.agents/skills <workspace>/.omp/skills <workspace>/repos/*/.claude/skills 2>/dev/null
   ```
   If none exists, skip this step.
2. Read the current value. The command replaces the whole list, so keep what is there:
   ```sh
   omp config get skills.customDirectories
   ```
3. Set the merged list (a JSON array of absolute paths). The directory itself, not a single skill, goes in the list:
   ```sh
   omp config set skills.customDirectories '["<workspace>/.claude/skills"]'
   ```
   Tell the human what you changed and that it applies to all of their OMP sessions. If the list already holds the path, change nothing.
4. Verify: `omp config get skills.customDirectories` prints the path, and each `<path>/<skill-name>/SKILL.md` has a `description` in its frontmatter. Report any skill that lacks one: OMP skips it.

Claude Code workers and Codex workers do not read OMP's setting. For those harnesses, tell the run lead to list the skills a step needs by absolute path in the worker's prompt (`<workspace>/.claude/skills/<name>/SKILL.md`). Write this under "Skills" in the final summary, and add the line to the project's `learnings.md` so run leads read it at plan time:

```markdown
- Workspace skills live in `<workspace>/.claude/skills`. OMP workers load them through `skills.customDirectories`. For Claude Code and Codex workers, pass the `SKILL.md` paths in the step prompt.
```

## 8. Write `ark.yml`

Write `~/.ark/projects/<project>/ark.yml` in the contract schema. Create the directory first (`mkdir -p ~/.ark/projects/<project>/tickets`). Never write over an existing file unless the human answered "replace" or "edit" in step 1.

```yaml
workspace: <absolute workspace path>
ticket_source: <local | github | jira>
compose: <compose command>        # omit when the project has no compose file
suites:
  - name: <unique name>
    level: <integration | e2e>
    repo: <repo path, or .>
    command: <command with {report}>
    parser: <bun | pytest | behave>
roles:
  implementer: { harness: <harness>, model: <model> }
  validator: { harness: <harness>, model: <model> }
  reviewer: { harness: <harness>, model: <model> }
```

Rules for the file:

- `workspace` is an existing absolute directory.
- `suites` has at least one entry, and each `name` is unique.
- Put `concurrency` and `round_budget` in only when the human asked for non-default values.
- Keep the file valid YAML with 2-space indentation and no tabs.

Show the human the written file.

## 9. Validate

`ark` loads `ark.yml` for every command, so a plain command checks the file:

```sh
ARK_PROJECT=<project> ark status
```

- Exit 0: the file passes the config check. Report "`ark.yml` is valid".
- Exit 1 with `config error: <project>: <message>`: the message names the field. Fix that field, run the command again, and tell the human what you fixed. Stop after two failed fixes and show the human the error.

## 10. Report

Tell the human, in one short list:

- The project name and the path of `ark.yml`.
- What you detected: repos, suites with level and parser, compose command, ticket source.
- What the human answered.
- What you registered in Orca, and what was already registered.
- The nesting depth result.
- The skills method you used.
- Anything left for the human (a missing `ac` marker hook, a missing `description`, a skipped repo).

The first ticket, `/skill:ark chief` with a ticket ID, is the E2E check of the whole setup.

