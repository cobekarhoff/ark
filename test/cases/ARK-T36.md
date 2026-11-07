---
id: ARK-T36
title: "ARK-T36 title is at most 72 characters: summary, ticket title, --summary, a refusal or a title_prefix rule"
level: integration
technique: decision table (summary field, ticket title, --summary flag, title_prefix) with boundary values at 72 and 73 characters of the whole title
priority: high
risk: a long ticket title becomes the MR title again, a title over 72 characters is pushed, a missing summary is pushed before the refusal, or a title_prefix rule is ignored
status: active
changed_by: 2026-11-06-ARK-316-1
---

## Objective

Prove the MR title rule: the whole title is 72 characters or less. `<ticket id>: <summary>` uses the `summary:` field, else the ticket title, each only when the whole title fits 72; else `--summary`; else a refusal before any push. A repo `title_prefix` rule wins, and its length counts. Serves ARK-316/AC3.

Expected: When no usable summary can be found, the system shall refuse before any push with `ticket has no summary: pass --summary`.

## Preconditions

- A fixture project and run for ticket `ARK-316` (the prefix `ARK-316: ` is 9 characters, so a summary of 63 characters gives a 72-character title), a bare fixture remote that records pushes, and a fake `gh`/`glab` that records `create` calls.
- Fixture tickets (lengths in characters):
  1. `summary:` of 28 characters ("MR bodies come from one core"), title of 120.
  2. no `summary:`, title of 63.
  3. no `summary:`, title of 64.
  4. `summary:` of 64, title of 40.
  5. `summary:` of 64, title of 120.
  6. no `summary:`, title of 120.
- A variant of the project config with `pr_writing.title_prefix: "feat(TICKET): desc"` (the prefix `feat(ARK-316): ` is 15 characters, so a summary of 57 characters gives 72).

## Steps

1. Run `ark merge-request open <run>` for ticket 1. Read the title in the create call.
2. Run it for ticket 2 (title 63, whole title 72).
3. Run it for ticket 3 (title 64, whole title 73) with no `--summary`. Check the exit code, the message and the remote pushes.
4. Run it for ticket 3 with `--summary "Short outcome text"`.
5. Run it for ticket 4 (long `summary:`, short title). Read the title.
6. Run it for ticket 5 and for ticket 6, each with no `--summary`; then again with `--summary "Short outcome text"`.
7. With the `title_prefix` rule configured, run it for ticket 1; for a ticket whose `summary:` is 57 characters; for a ticket whose `summary:` is 58 characters and whose title is 120.
8. For every title posted in steps 1-7, measure the whole title length.
9. Run `bun test test/pr-writing.test.ts`.

## Expected results

- Ticket 1: title is `ARK-316: MR bodies come from one core` (the `summary:` field, not the long title).
- Ticket 2: title is `ARK-316: <the 63-character title>`, 72 characters in total. The 72 boundary is accepted.
- Ticket 3 without `--summary`: exits 1 with `ticket has no summary: pass --summary`, and the remote records no push, because the whole title would be 73. With `--summary "Short outcome text"` the title is `ARK-316: Short outcome text`.
- Ticket 4: the 64-character `summary:` is not usable (the whole title would be 73), so the title is `ARK-316: <the 40-character ticket title>`.
- Tickets 5 and 6 without `--summary`: the same refusal before any push. With `--summary` the title uses the flag text.
- With the `title_prefix` rule the title follows `feat(ARK-316): <summary>`, not the default. A 57-character summary gives 72 characters and is accepted; a 58-character summary with a 120-character title is refused with `ticket has no summary: pass --summary` before any push.
- No title posted in this case is longer than 72 characters, so TITLE01 (ARK-T21) never fails on an `ark merge-request open` title.
- `bun test test/pr-writing.test.ts` exits 0.

## Screenshot checkpoints

None. The surface is CLI output and Markdown text; no screenshot applies.
