# Bootstrap a project

Bootstrap teaches Ark one project: its repos, its integration and E2E test suites, how its repos run together, and where its tickets live. You do it once for each project. Master Chief does the work with the bootstrap playbook. It detects what it can from your files and asks you only for the rest.

This page covers two cases:

- [A single repo](#bootstrap-a-single-repo), with Ark itself as the example.
- [A meta-repo](#bootstrap-a-meta-repo-that-holds-several-repos), with Clara as the example.

## Before you begin

You need:

- The Orca desktop app, running, and its `orca` CLI on your PATH. Master Chief must run inside an Orca terminal. Ark runs `orca repo list` and `orca orchestration ...` for you.
- [Bun](https://bun.sh), [OMP](https://omp.sh) and `git`. Ark is set up as in the [README](../../README.md): `bun link` puts `ark` on your PATH, and `omp plugin link .` makes `/skill:ark` available in OMP.
- `jq`. The [background services](background-services.md) need it.
- Any other harness your roles use, such as `claude` or `codex`.
- For a project with several repos that run together, Docker with Docker Compose.

## Bootstrap a single repo

1. Open a terminal in Orca in the repo, start `omp`, and run `/skill:ark bootstrap`. This session plays Master Chief for the setup. For Ark:

   ```sh
   cd ~/Dev/abbott/ark
   omp
   ```

   Then, in the `omp` session, run `/skill:ark bootstrap`.

2. Wait while Master Chief detects the project. It asks you nothing yet. It reads:

   - The repo list: the workspace itself, because it has one `.git`.
   - The stack, from `bun.lock` and `package.json`: Bun and TypeScript.
   - The suites. In Ark, the tests under `test/` run with `bun test` and tag each test with an AC ID, so they form one integration suite.
   - The compose command: none, because Ark has no compose file.
   - The setup command: `bun install --frozen-lockfile`, from `bun.lock`.
   - The ticket source: local, because the tickets are Markdown files in `~/.ark/projects/ark/tickets/`.

3. Answer any questions. Master Chief asks one at a time and recommends an answer. For example:

   > Which models should the roles use? Recommended: the newest Anthropic Sonnet-class model that `omp models --json` lists for the implementer, validator, evaluator, designer, chief and test writer, and a model from another vendor for the reviewer and test reviewer, because cross-vendor review catches more defects.

   Reply with "yes" to take the recommendation, or give your own answer.

4. If `~/.ark/projects/ark/ark.yml` already exists, Master Chief asks whether to keep, replace or edit it. It never overwrites the file without your answer.

5. Master Chief checks Orca. It registers the repo in Orca, with non-Orca worktrees shown, so Orca can launch agents into Ark's worktrees. A repo that is already registered stays as it is. If it is registered with worktrees hidden, Master Chief asks before it changes that.

6. Master Chief confirms Orca's nesting depth by starting a throwaway worker. If Orca refuses it, set the depth yourself:

   1. Open Orca and go to **Settings → Orchestration → Nested worker depth**.
   2. Set it to 2.
   3. Tell Master Chief. It tests again.

7. Master Chief writes `~/.ark/projects/ark/ark.yml` and validates it with `ark status`. For Ark, the file has one `bun` integration suite and every role. The keys and an example file are in [the `ark.yml` fields](../reference/cli.md#arkyml-fields).

   `ark status` fails without `implementer`, `validator` and `reviewer`. The other roles are optional in the file, but each run needs them: the `roles` row of the reference says what stops without each.

   If a repo has UI code, Master Chief also offers to make `PRODUCT.md` with impeccable `init` and `DESIGN.md` with impeccable `document` in that repo. With no UI code, it asks one question: is the project designed for a UI that does not exist yet? On yes it offers `PRODUCT.md` only. On no it makes no design file. It never writes over an existing `PRODUCT.md` or `DESIGN.md`: it skips the file and names it in the summary.

   Commit and merge the files it made. Run worktrees start from the base branch, so an uncommitted file is not in a run's worktree. On the next web UI run after the merge, the Designer reads the files through `impeccable context`. If a file is missing, the Designer says so in `strategies.md`.

8. Master Chief writes `~/.ark/projects/<project>/verify.md`, the guide that the validator uses for a live check of the real app. It has three parts: how to start the app, how to reach it, and a feature map with one row for each feature, the command or page that exercises it, and what a working result shows. Master Chief detects what it can from the README, the scripts and the docs, and asks you only for the rest. For Ark, it writes `~/.ark/projects/ark/verify.md` for the hub (`ark ui`) and the CLI. If the file exists, it asks whether to keep, replace or edit it. When a later validator finds the file wrong, the run lead proposes a fix with the scope `project` in the retro.

9. Read the summary Master Chief prints. It lists what it detected, what you answered, what it registered in Orca, the `verify.md` it wrote, and anything left for you.

## Bootstrap a meta-repo that holds several repos

A meta-repo is a workspace with a `repos/` folder of nested repos. Clara is one: `clara-agentic-environment` holds `repos/platform`, `repos/shared/packages` and more. Follow the steps for a single repo, with these differences.

1. Open an Orca terminal in the meta-repo root, start `omp`, and run `/skill:ark bootstrap`:

   ```sh
   cd ~/Dev/abbott/clara-agentic-environment
   omp
   ```

2. Master Chief detects more. It finds every nested repo up to four levels deep, for example `repos/platform` and `repos/shared/packages`. For each repo it reads the stack: Python from `pyproject.toml`, Node from `package.json`. It looks for suites by name (`integration`, `e2e`) and picks the runner and parser: `pytest` for Python suites, `behave` for suites with `.feature` files, `bun` for Bun tests. It reads `docker-compose.yml` at the workspace root and the `Taskfile` for the team's compose command. It reads the ticket source from `.mcp.json` and the docs: Jira for Clara, although the code is on GitLab.

3. Master Chief registers the workspace and every nested repo in Orca, each with non-Orca worktrees shown. Orca needs this to launch agents into the run's worktrees of each repo.

4. Ark makes the workspace's own skills reachable. Clara keeps skills in `.claude/skills`, and OMP does not find them from a run's nested worktrees. `ark worktree anchor` and `ark worktree create` write `skills.customDirectories` into each nested worktree's `.omp/config.yml`, with the mirror path of each of `.claude/skills`, `.agents/skills` and `.omp/skills` that the workspace root has. Your global OMP config does not change. Master Chief only checks that each `SKILL.md` has a `description`. For Claude Code and Codex workers, the run lead passes the skill paths in each worker's prompt.

5. Check the written `ark.yml`. For a meta-repo, it has one suite for each integration or E2E suite, and each suite names its repo, as `repos/platform`. Your detected values differ from Ark's. Its `command` is the runner's own command with the report path in `{report}`: `pytest` takes `--junitxml={report}`, `behave` takes `-o {report}`. The [`ark.yml` fields](../reference/cli.md#arkyml-fields) hold the keys and an example. Set the same roles as for a single repo.

   `ark test` runs each suite from `<run folder>/workspace/<repo>`. Before the suites it runs `docker compose --project-directory <run folder>/workspace -p <run id in lowercase> up -d --wait`, so the compose file resolves every `./repos/*` path to the run's worktrees. After the suites it runs `down`.

## Check that bootstrap worked

1. Run the config check yourself. Use your project name in place of `ark`:

   ```sh
   ARK_PROJECT=ark ark status
   ```

   `ark status` reads `ark.yml`, then checks that each role's harness is on your PATH and that each omp role's model is in `omp models --json`. If everything passes, it exits 0 and lists your open runs, or prints this:

   ```text
   no open runs
   ```

   A field that is wrong, or a missing required role, prints the file, the field and the reason, then exits 1:

   ```text
   config error: ark: /Users/you/.ark/projects/ark/ark.yml: suites[0].parser must be one of bun, pytest, behave
   no open runs
   ark: 1 project config(s) invalid
   ```

   A key that Ark does not know is an error too, and it names the nearest valid key: `merge_request is not a key; did you mean merge_requests?`. A suite `command` with no `{report}` is refused with `suites[0].command must write its JUnit report to {report}`.

   A role that cannot run prints the project, each role and the reason, then exits 1. Here a role names a harness that is not installed:

   ```text
   no open runs
   ark
     role validator: harness pi not installed
   ark: 1 role(s) cannot run
   ```

   And here two roles name an omp model that omp does not list:

   ```text
   no open runs
   ark
     role implementer: omp anthropic/nope-9: model not found by omp
     role validator: omp anthropic/nope-9: model not found by omp
   ark: 2 role(s) cannot run
   ```

   `ark status` does not check `evaluator`, `designer`, `test_writer` or `test_reviewer`, because they are optional in the file. Read the `roles` row of [the `ark.yml` fields](../reference/cli.md#arkyml-fields) and confirm you set them.

2. Run `orca repo list --json` and check that each repo of the project appears with `externalWorktreeVisibility` set to `show`. The output is JSON; each repo is an entry in `result.repos`:

   ```json
   {
     "result": {
       "repos": [
         { "id": "...", "path": "/Users/you/Dev/abbott/ark", "externalWorktreeVisibility": "show" }
       ]
     }
   }
   ```

   The real output has more fields for each repo.

3. Start the first ticket with Master Chief: `/skill:ark chief` and a ticket ID. The first run is the E2E check of the whole setup.

## Change a project later

Edit `~/.ark/projects/<project>/ark.yml` by hand, or run `/skill:ark bootstrap` again and answer "edit" when it finds the file. Add lessons for run leads to `~/.ark/projects/<project>/learnings.md`, and fix `~/.ark/projects/<project>/verify.md` when the app starts or behaves differently. The [retro playbook](../../skills/ark/playbooks/retro.md) proposes such changes for your approval.

## Related

- [The `ark.yml` fields](../reference/cli.md#arkyml-fields)
- [Architecture: multi-repo by local composition](../explanation/architecture.md#multi-repo-by-local-composition)
- [Orca spike findings](../research/orca-spikes.md)
