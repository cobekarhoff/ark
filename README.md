# Ark

Ark is an [Oh My Pi (OMP)](https://omp.sh) plugin and deterministic command-line interface (CLI) that turns a ticket into merge-ready changes across one or more repositories, with a replayable record of decisions and evidence. The core rule: **agents plan, implement, validate and review; humans approve the gates and merge.** The orchestrator coordinates the work; it does not implement the product itself.

## Requirements

- [Bun](https://bun.sh) 1.4.
- [OMP](https://omp.sh), installed and configured with access to the models in `.omp/config.yml`.
- Git and a GitHub repository with the `gh` CLI authenticated for opening merge requests (GitHub pull requests).

## Install

From this checkout:

```sh
bun install
bun link
omp plugin link .
```

`bun link` puts `ark` on your executable search path; installing the plugin alone does not. Undo with `bun unlink` and `omp plugin uninstall ark`.

## Quickstart

1. Work in a repository with an `ark.yml` containing its project name (this repository uses `project: ark`). Put the ticket at `~/.ark/projects/<project>/tickets/<ID>.md`, ideally with explicit acceptance criteria. See [setup](site/src/content/docs/setup.md) for a ticket example and model prerequisites.
2. Start the supported orchestrator session:
   ```sh
   ark launch
   ```
3. In that OMP session, start the ticket flow:
   ```text
   /skill:ark ticket <ID>
   ```
   Ark starts or resumes the ticket's run. Read each gate packet and answer its matching question; the agents do the implementation and checks in a worktree.
4. After evidence approval, inspect the merge request on GitHub, merge it yourself, and confirm the outcome in the session. Agents never merge for you.

## How a run works

- **Criteria:** clarify acceptance criteria when the ticket has none.
- **Plan:** approve the approach and what proof is required before implementation.
- **Escalation:** choose another round, human takeover or abort when the round budget is spent and checks still fail.
- **Evidence:** approve the traceable results, send them back or abort.
- **Human merge:** merge or close the opened merge requests and confirm the outcome.

`setup` is reserved, not an implemented gate. See the [lifecycle guide](site/src/content/docs/lifecycle.md) and [interactive execution flow](site/src/content/docs/flow.mdx) in the docs site for branches and handoffs.

## Docs

```sh
bun run docs:build
bun run docs:preview
```

Open the address printed by preview. The static site in `site/dist/` includes the newcomer path, interactive explorers and local search. Pages are authored in `site/src/content/docs/`; build-time generation reads the actual CLI help, lifecycle table and ticket playbook into ignored `site/.generated/`. Rebuild after changing those sources. No server runtime, hosted search or deployment credentials are needed.

The [framework decision](docs/adr/0004-documentation-site.md) compares seven alternatives. Deep operational detail previously in this README is now in the site's [implementation reference](site/src/content/docs/reference/implementation.md).

## Development

```sh
bun test
bun run docs:build
```

Continuous integration (CI) installs with the frozen Bun lockfile, builds the docs with the same command and runs `bun test`. The CLI tests resolve models through OMP's own code; CI pins `@oh-my-pi/pi-coding-agent@18.12.6`. There is no separate lint script. See the [implementation reference](site/src/content/docs/reference/implementation.md) for guardrails and the [product requirements document](docs/prd.md) for the full contract.
