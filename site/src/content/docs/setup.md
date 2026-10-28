---
title: Setup and first ticket
description: Install Ark, configure the project and model roles, and start a ticket in the supported session.
---

## Requirements and install

Install Bun 1.4 and [Oh My Pi (OMP)](https://omp.sh). Ark uses Git worktrees;
opening merge requests (MRs), which are GitHub pull requests, also needs GitHub's
`gh` command-line interface (CLI) and host credentials. From the Ark checkout:

```sh
bun install
bun link
omp plugin link .
```

`bun link` puts `ark` on the executable search path; plugin installation alone does
not. Remove the links with `bun unlink` and `omp plugin uninstall ark`.

## Prepare a project

Ark finds the nearest `ark.yml` above the working directory. This repository has:

```yaml
project: ark
```

Ticket storage is outside the checkout. By default a ticket lives at
`~/.ark/projects/<project>/tickets/<ID>.md`. Set `ARK_HOME` to move that storage root.
For example, save `~/.ark/projects/ark/tickets/ARK-200.md` with this **illustrative** content:

```markdown
---
id: ARK-200
title: Add a readable empty state
status: open
acceptance_criteria:
  - id: ARK-200-AC1
    text: The empty list explains how to add a ticket.
  - id: ARK-200-AC2
    text: The next action can be reached with the keyboard.
---

Show a useful next action when a ticket list is empty.
```

These are example requirements, not a completed ticket. The opening frontmatter
requires `id`, `title` and `status`; acceptance criterion (AC) entries each need
an `id` and `text`. Ark reads `acceptance_criteria` from this metadata, not from
body bullets. Keep the IDs stable: the run copies them into `ac.yml`.
A ticket without ACs opens the criteria gate; a ticket with ACs skips that gate,
not the plan gate.

## Configure model access

The project's `.omp/config.yml` binds `implement`, `validate`, `review-x` and
`review-s` model roles. Check the configured selectors against models available to
your OMP installation (`omp models anthropic` and `omp models openai-codex` for
this repository), and provide access through OMP. `ark preflight` resolves the
actual candidates and fallback chains, including global configuration. It refuses
if validation or cross-vendor review can reach the implementer's vendor, or
same-vendor review can reach a different vendor. It also refuses if OMP cannot be loaded.
See [agents and models](/agents/); do not bypass a refusal by weakening the vendor rule.

## Start one ticket

1. From the project checkout, run:
   ```sh
   ark launch
   ```
   This is the supported orchestrator session, with typed Ark tools and restricted
   shell/credential access. A plain OMP session running the skill is not equivalent.
2. In that session, invoke:
   ```text
   /skill:ark ticket ARK-200
   ```
   The router starts or resumes the run, reads the ticket and follows the ticket playbook.
3. Read the plan packet and answer the matching main-session question. When
   criteria are missing, resolve the criteria gate first. Agents then implement,
   validate and review in the run's worktree.
4. Review the evidence packet. Approve only the results you intend to submit;
   sending back or aborting are explicit alternatives. After approval, Ark opens
   one MR per repository. **You** merge or close them on GitHub, then confirm
   `merged` or `abandoned` in the session.

Gate answers require the exact successful main-session ask result bound to the
run, action and packet hash. Outside OMP, typing the answer on `/dev/tty` is an
additional confirmation, **not a replacement for that proof**. Never script approval.

## Resume and troubleshoot

`ark run start <ID>` resumes an existing open run, replays its ledger and repairs
missing or stale cached state; it does not create a second open run for that ticket.
`ark doctor` checks that the host default branch protects administrators, requires
a pull request and passing checks, and forbids force pushes. Follow a refusal's
message rather than editing state files. `setup` is a reserved gate ID, not an
implemented setup command or gate. See [CLI help](/reference/commands/) for exact syntax.
