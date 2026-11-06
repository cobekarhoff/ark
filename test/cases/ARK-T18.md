---
id: ARK-T18
title: ARK-T18 title uses summary, short title, --summary, a refusal or a title_prefix rule
level: integration
technique: decision table (summary field, title length, --summary flag, title_prefix) with boundary values at 72 and 73 characters
priority: high
risk: a long ticket title becomes the MR title again, a missing summary is pushed before the refusal, or a title_prefix rule is ignored, so MRs get 100+ character titles or a branch is pushed with no usable title
status: active
changed_by: 2026-11-06-ARK-316-1
---

## Objective

Prove the MR title rule: `<ticket id>: <summary>`, with the summary from the `summary:` field, else the ticket title of 72 characters or less, else `--summary`, else a refusal before any push; a repo `title_prefix` rule wins. Serves ARK-316/AC3.

Expected: When no summary can be found, the system shall refuse before any push with `ticket has no summary: pass --summary`.

## Preconditions

- A fixture project and run, a bare fixture remote that records pushes, and a fake `gh`/`glab` that records `create` calls.
- Four fixture tickets: (1) has `summary: "MR bodies come from one core"` and a 120-character title; (2) no `summary:`, a title of exactly 72 characters; (3) no `summary:`, a title of 73 characters; (4) no `summary:`, a 120-character title.
- A variant of the project config with `pr_writing.title_prefix` set to the rule `type(TICKET): desc`.

## Steps

1. Run `ark merge-request open <run>` for ticket 1. Read the title in the create call.
2. Run it for ticket 2 (72 characters).
3. Run it for ticket 3 (73 characters) with no `--summary`. Check the exit code, the message and the remote pushes.
4. Run it for ticket 3 with `--summary "Short outcome text"`.
5. Run it for ticket 4 with no `--summary`; then again with `--summary`.
6. Run it for ticket 1 with the `title_prefix` rule configured.
7. Run `bun test test/pr-writing.test.ts`.

## Expected results

- Ticket 1: title is `ARK-<n>: MR bodies come from one core` (the `summary:` field, not the long title).
- Ticket 2: title is `<ticket id>: <the 72-character title>`. The 72 boundary is accepted.
- Ticket 3 without `--summary`: exits 1 with `ticket has no summary: pass --summary`, and the remote records no push. With `--summary` the title is `<ticket id>: Short outcome text`.
- Ticket 4 without `--summary`: the same refusal before any push. With `--summary` the title uses the flag text.
- With the `title_prefix` rule the title follows `type(TICKET): desc` (the ticket id in place of TICKET), not the default `<ticket id>: <summary>`.
- `bun test test/pr-writing.test.ts` exits 0.

## Screenshot checkpoints

None. The surface is CLI output and Markdown text; no screenshot applies.
