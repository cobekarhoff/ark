# pr-writing skill

Writes the title and body of a merge request (GitLab) or pull request (GitHub), lints it, and posts a Draft after the human says go. It is one skill with four TypeScript scripts: `gather.ts`, `review.ts`, `lint_body.ts`, `post_mr.ts`. Ark uses the same code (`lib/`) for its own MRs; this README is for a repo that is not Ark.

## Reach the skill from a repo outside Ark

`skill://pr-writing` does not exist in a non-Ark session. The skill lives in the Ark plugin, so point the agent at the plugin path, for example `~/.omp/plugins/node_modules/ark/skills/pr-writing/SKILL.md`, and run the scripts from that path while your working directory is the repo to post.

You need the whole Ark plugin folder, not a copy of `skills/pr-writing/`: the scripts import `skills/pr-writing/lib/`, and `lib/` imports `cli/` (for example `cli/errors.ts`). Requirements: `bun`, `git`, and `gh` (GitHub) or `glab` (GitLab), signed in.

Run each script as `bun <plugin>/skills/pr-writing/scripts/<name>.ts`. Each has `--help` and `--json-schema`.

## Add the trigger line to the repo's AGENTS.md

Put this in the repo's `AGENTS.md` (or `CLAUDE.md`), with `<plugin>` set to the real path:

```text
When you open a merge request or pull request, or write or update its description, read <plugin>/skills/pr-writing/SKILL.md first and follow it. Post only through post_mr.ts, after I say go.
```

## The flow

1. `bun <plugin>/skills/pr-writing/scripts/gather.ts` writes `.pr-writing/ledger.json` and a first `.pr-writing/body.md` (the folder is gitignored).
2. `review.ts` runs the shell checks from config and records pass, fail or `not_run`.
3. Edit `.pr-writing/body.md`, then `lint_body.ts`.
4. Show the human the title, body and lint report. Wait for a go in this conversation.
5. `post_mr.ts --confirmed` creates a Draft, or updates the open one inside the `pr-writing` markers. `--ready` opens it ready. Without `--confirmed` it refuses.

Outside Ark there is no ticket, so pass `--title` to `lint_body.ts` and `post_mr.ts`. The repo's own MR or PR template wins over the default layout.

## `.pr-writing.toml`

Optional file at the repo root. Unknown keys exit 1.

```toml
reviewers = ["alice", "bob"]
tier_floor = 1
sensitive_paths = ["migrations/", "auth/"]
agent_authored = true
title_prefix = "feat(TICKET): desc"
checks = ["bun run typecheck", "bun test"]
```

| Key               | Meaning                                                                     | Default |
| ----------------- | --------------------------------------------------------------------------- | ------- |
| `reviewers`       | Handles passed to the host at create and update.                            | none    |
| `tier_floor`      | Lowest size tier, 0 to 3. A higher tier allows a longer body.               | 0       |
| `sensitive_paths` | A changed path matching a directory or glob here makes the tier at least 1. | none    |
| `agent_authored`  | When true the body starts with the provenance line.                         | true    |
| `title_prefix`    | Title rule, for example `feat(TICKET): desc`. The title must match it.      | none    |
| `checks`          | Shell commands for `review.ts`.                                             | none    |

Override any key with an environment variable `PR_WRITING_<KEY>`, for example `PR_WRITING_TIER_FLOOR=2`. Lists are comma separated, booleans are `true` or `false`. The environment wins over the file.

## GitHub and GitLab

The host is read from the `origin` remote. GitHub uses `gh` and makes a Draft PR; GitLab uses `glab` and makes a Draft MR. Both use the same body, lint and markers. A remote that is neither exits 2. Commands, templates and ref syntax are in `references/github.md` and `references/gitlab.md`.

## Not built yet

Diagrams: not built (ARK-400), there is no `diagram.ts`. `post_mr.ts` uploads the screenshots and videos of the body on both hosts: GitHub needs `gh` 2.99.0 or newer and write access, and a failed upload exits 2 and posts nothing. Text evidence goes in `<details>` blocks, and evidence is never committed. The fresh-context self-review is not in `review.ts` either; it runs shell checks only.
