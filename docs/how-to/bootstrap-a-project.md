# Bootstrap a project

Bootstrap teaches Ark one project: its repos, its integration and E2E test suites, how its repos run together, and where its tickets live. You do it once for each project. Master Chief does the work with the bootstrap playbook. It detects what it can from your files and asks you only for the rest.

This page covers two cases:

- [A single repo](#bootstrap-a-single-repo), with Ark itself as the example.
- [A meta-repo](#bootstrap-a-meta-repo-that-holds-several-repos), with Clara as the example.

## Before you begin

You need:

- The Orca desktop app, running. Master Chief must run inside an Orca terminal.
- The `ark` CLI and `git` on your path.
- The harnesses your roles use, such as `claude` and `codex`.
- For a project with several repos that run together, Docker with Docker Compose.

## Bootstrap a single repo

1. Open a terminal in Orca and start Master Chief in the repo. For Ark:

   ```sh
   cd ~/Dev/abbott/ark
   ```

   Then start your harness and run `/skill:ark bootstrap`.

2. Wait while Master Chief detects the project. It asks you nothing yet. It reads:

   - The repo list: the workspace itself, because it has one `.git`.
   - The stack, from `bun.lock` and `package.json`: Bun and TypeScript.
   - The suites. In Ark, the tests under `test/` run with `bun test` and tag each test with an AC ID, so they form one integration suite.
   - The compose command: none, because Ark has no compose file.
   - The ticket source: local, because the tickets are Markdown files in `~/.ark/projects/ark/tickets/`.

3. Answer any questions. Master Chief asks one at a time and recommends an answer. For example:

   > Which models should the roles use? Recommended: the default, `claude-sonnet` for the implementer and `gpt-codex` for the validator and reviewer, because cross-vendor review catches more defects.

   Reply with "yes" to take the recommendation, or give your own answer.

4. If `~/.ark/projects/ark/ark.yml` already exists, Master Chief asks whether to keep, replace or edit it. It never overwrites the file without your answer.

5. Master Chief checks Orca. It registers the repo in Orca, with non-Orca worktrees shown, so Orca can launch agents into Ark's worktrees. A repo that is already registered stays as it is. If it is registered with worktrees hidden, Master Chief asks before it changes that.

6. Master Chief confirms Orca's nesting depth by starting a throwaway worker. If Orca refuses it, set the depth yourself:

   1. Open Orca and go to **Settings → Orchestration → Nested worker depth**.
   2. Set it to 2.
   3. Tell Master Chief. It tests again.

7. Master Chief writes `~/.ark/projects/ark/ark.yml` and validates it with `ark status`. For Ark, the result looks like this:

   ```yaml
   workspace: /Users/you/Dev/abbott/ark
   ticket_source: local
   suites:
     - name: integration
       level: integration
       repo: .
       command: bun test --reporter=junit --reporter-outfile={report}
       parser: bun
   roles:
     implementer: { harness: claude, model: claude-sonnet }
     validator: { harness: codex, model: gpt-codex }
     reviewer: { harness: codex, model: gpt-codex }
   ```

8. Read the summary Master Chief prints. It lists what it detected, what you answered, what it registered in Orca, and anything left for you.

## Bootstrap a meta-repo that holds several repos

A meta-repo is a workspace with a `repos/` folder of nested repos. Clara is one: `clara-agentic-environment` holds `repos/platform`, `repos/shared/packages` and more. Follow the steps for a single repo, with these differences.

1. Start Master Chief in the meta-repo root:

   ```sh
   cd ~/Dev/abbott/clara-agentic-environment
   ```

   Then run `/skill:ark bootstrap`.

2. Master Chief detects more. It finds every nested repo up to four levels deep, for example `repos/platform` and `repos/shared/packages`. For each repo it reads the stack: Python from `pyproject.toml`, Node from `package.json`. It looks for suites by name (`integration`, `e2e`) and picks the runner and parser: `pytest` for Python suites, `behave` for suites with `.feature` files, `bun` for Bun tests. It reads `docker-compose.yml` at the workspace root and the `Taskfile` for the team's compose command. It reads the ticket source from `.mcp.json` and the docs: Jira for Clara, although the code is on GitLab.

3. Master Chief registers the workspace and every nested repo in Orca, each with non-Orca worktrees shown. Orca needs this to launch agents into the run's worktrees of each repo.

4. Master Chief makes the workspace's own skills reachable. Clara keeps skills in `.claude/skills`, and OMP does not find them from a run's worktrees. Master Chief adds the directory to OMP's `skills.customDirectories` setting:

   ```sh
   omp config get skills.customDirectories
   omp config set skills.customDirectories '["/Users/you/Dev/abbott/clara-agentic-environment/.claude/skills"]'
   ```

   This applies to all your OMP sessions. It keeps any entries already in the list. For Claude Code and Codex workers, the run lead passes the skill paths in each worker's prompt.

5. Check the written `ark.yml`. For a meta-repo, it has one suite for each integration or E2E suite, and each suite names its repo. This example shows the shape. Your detected values differ:

   ```yaml
   workspace: /Users/you/Dev/abbott/clara-agentic-environment
   ticket_source: jira
   compose: docker compose
   suites:
     - name: platform-integration
       level: integration
       repo: repos/platform
       command: pytest -o junit_family=xunit1 --junitxml={report} tests/integration
       parser: pytest
     - name: end-to-end
       level: e2e
       repo: repos/end-to-end-tests
       command: behave --format json -o {report} features
       parser: behave
   roles:
     implementer: { harness: claude, model: claude-sonnet }
     validator: { harness: codex, model: gpt-codex }
     reviewer: { harness: codex, model: gpt-codex }
   ```

   `ark test` runs each suite from `<run folder>/workspace/<repo>`. Before the suites it runs `docker compose --project-directory <run folder>/workspace -p <run id> up -d --wait`, so the compose file resolves every `./repos/*` path to the run's worktrees.

## Check that bootstrap worked

1. Run the config check yourself:

   ```sh
   ARK_PROJECT=ark ark status
   ```

   Use your project name in place of `ark`. Exit code 0 means `ark.yml` passes. For an invalid file, the command exits 1 and prints `config error: <project>: <message>`. The message names the field to fix.

2. Run `orca repo list --json` and check that each repo of the project appears with `externalWorktreeVisibility` set to `show`.

3. Start the first ticket with Master Chief: `/skill:ark chief` and a ticket ID. The first run is the E2E check of the whole setup.

## Change a project later

Edit `~/.ark/projects/<project>/ark.yml` by hand, or run `/skill:ark bootstrap` again and answer "edit" when it finds the file. Add lessons for run leads to `~/.ark/projects/<project>/learnings.md`. The [retro playbook](../../skills/ark/playbooks/retro.md) proposes such changes for your approval.

## Related

- [The `ark.yml` fields](../reference/cli.md#arkyml-fields)
- [Architecture: multi-repo by local composition](../explanation/architecture.md#multi-repo-by-local-composition)
- [Orca spike findings](../explanation/orca-spikes.md)
