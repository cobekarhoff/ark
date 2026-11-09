---
name: pr-writing
description: Use when opening a merge request or pull request, writing or updating its description, or preparing a change for review. Triggers - 'merge request', 'pull request', 'MR', 'PR description', 'open an MR', 'open a PR', 'update the MR body'. Builds the body from git and the host, lints it, and posts a Draft only after the human says go.
---

# pr-writing

Write the MR or PR the way a reviewer reads it: the problem first, the proof next, what is not done, how to revert.
Scripts are TypeScript, run from the repo you post: `bun <skill dir>/scripts/<name>.ts`. All four print one JSON document on stdout and prose on stderr. Exit 0 ok, 1 violation or refusal, 2 environment (auth, network, missing tool). Add `--help` for examples and `--json-schema` for the stdout shape.

## 0 Gather

1. `gather.ts` writes `.pr-writing/ledger.json` and a first `.pr-writing/body.md` from git and the host. Add `--base <branch>` when it cannot tell the base.
2. `gather.ts --existing-only` prints the open MR of this branch, or nothing. Run it before you write: an open MR means an update, and text a person wrote outside the markers stays.
3. `review.ts` runs the shell checks in `.pr-writing.toml` (`checks`) and records pass, fail or `not_run` with the last 50 lines of output. It changes no file. Paste its results into section 5, never a claim without one.
4. Read the repo's MR or PR template if one exists. The repo template wins: keep its headings and fill them. `gather.ts` finds it (`.gitlab/merge_request_templates/Default.md`, `.github/pull_request_template.md`, others in `lib/ledger.ts`).
5. Inside an Ark run, `gather.ts --run-dir <run folder>` reads the Ark ledger instead of git.

## 1 Who did what

- When `agent_authored` is true (the default) the body's first line says an agent wrote it. Variants, by who shaped the work:
  - `> Written by an AI agent on behalf of @handle. @handle has not reviewed it yet.`
  - add `, following their spec` before the final period when the human wrote the spec.
  - add `, who shaped the solution` before the final period when the human chose the approach.
- `@handle` is the token owner the host reports (`gh` or `glab`). Never guess it. If the probe failed, sign in first.
- Never add `Co-Authored-By: <model>` or `Generated with ...` to the body or commits (lint PROV02).

## 2 Title

- Imperative, 72 characters or less, no trailing period: `Fix retry on 429`.
- Ark form is `<ticket id>: <summary>` where summary is the short `summary` of the ticket. Outside Ark there is no ticket, so pass `--title`.
- A `title_prefix` rule in `.pr-writing.toml` wins, for example `feat(TICKET): desc`. The title must match it (lint TITLE01).

## 3 Size by decision cost

Size the body by what the reviewer must decide, not by diff size. Tier is the larger of the changed-line tier and `tier_floor`; a path in `sensitive_paths` makes it at least 1.

- Tier 0: 20 changed lines or less. At most 3 prose lines, no headings.
- Tier 1: under 150 lines. At most 12 prose lines.
- Tier 2: under 400 lines. At most 40 prose lines.
- Tier 3: 400 lines or more. At most 150 prose lines.

Over the ceiling: cut, do not compress. Lint SIZE01 fails over the ceiling. SIZE02 fails a heading at tier 0 unless the repo template names headings.

## 4 Order for a skimmer

Use this order, under the repo template's headings when it has them:

1. Provenance line, then `Refs:` and any `Depends on` or merge order line.
2. Problem: who is hurt and how, in plain words, before any implementation verb.
3. What is different: behavior, not a list of files. No restating the diff.
4. Evidence (section 5).
5. How to verify: `- [ ]` items, each a command plus `Expect: ...`.
6. Not done: every gap, named. Nothing here means write `- Nothing open.`, the line `gather.ts` writes.
7. Risk and revert: what breaks, who sees it, and the exact `git revert` or rollback step.

Write about the system. The subject of a sentence is the code, the command, the document or the data: "The hub typed phase as a string", "`ark run start` warns on an unknown status". The roles of the process (run lead, agent, implementer, the human) and first person appear only in the provenance line (lint VOICE01). Lint fails on a hard-wrapped paragraph (FMT01) or a token-like string (FMT02), and warns on a problem text that describes code instead of the problem (ELI01).

## 5 Evidence

- Every claim of "tested", "passed" or "verified" carries the command and its result line, or a file in the repo. "Self-review completed" with no command is not evidence. Lint fails a body with no `- [ ]` verify item (VAL01) and warns on an item with no command or no `Expect` (VAL02).
- Numbers carry bounds: n, the date, the base and head, what was excluded.
- Name at most 5 screenshots (EVID04 warns). Captures and structure diagrams are not built yet: attach screenshots by hand.
- The full list of lint checks and what each wants: `references/evidence.md`.

## 6 Keep it honest

- Name what you did not run, and why. Write `Not run: <what>, <reason>`.
- Do not paste an acceptance criterion or issue text as if it were a result.
- Files named in the body must be in the diff (DIFF01). Files in the diff that are not in the plan get a reason.
- A one-way door (migration, data delete, published API) names its recovery. A CI file change is named in the body.
- Do not hide a failing check: a `fail` from `review.ts` goes in the body as it is.

## 7 Lint and hand over

1. Write the final title and body to `.pr-writing/body.md` (or `--body <file>`).
2. `lint_body.ts [--title <text>]` lints against the ledger and records the body hash. Exit 1 means at least one `fail`: fix the body and run it again. A `warn` is allowed, but say why you kept it.
3. Show the human the title, the body and the lint report. Then wait.
4. Never pass `--confirmed` in the turn that drafted the body unless the human said go in this conversation. A go from an earlier task or another conversation does not count.
5. Any edit after lint, or a new commit, makes STALE01 fail: run `gather.ts`, `lint_body.ts`, show the human again.

## 8 Post

`post_mr.ts --confirmed [--ready] [--title <text>] [--body <file>]`

- Without `--confirmed` it refuses and posts nothing, exit 1.
- A new MR or PR is a Draft. `--ready` opens it ready. An update keeps the state of the open one.
- An update replaces only the text between `<!-- pr-writing:begin -->` and `<!-- pr-writing:end -->`. An old body with no markers is rewritten once, with a note on stderr.
- It re-runs the lint on the final body and refuses on a `fail` or STALE01 (head moved, or body edited after lint).
- `post_mr.ts --confirmed` is the only way to post. Do not call `gh` or `glab` to create or edit the MR yourself.
- Print the URL from stdout to the human. Host commands and quirks: `references/gitlab.md`, `references/github.md`.
