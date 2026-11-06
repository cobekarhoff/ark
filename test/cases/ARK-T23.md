---
id: ARK-T23
title: ARK-T23 post creates and updates one MR and keeps a human edit
level: integration
technique: state transition (no MR, MR exists) plus error guessing on a failing probe and --dry-run
priority: high
risk: an update overwrites a tick a human made outside the markers, two MRs are created for one branch, a failed probe falls through to a write, the author becomes reviewer, or --dry-run writes
status: active
changed_by: 2026-11-06-ARK-316-1
---

## Objective

Prove that `post.ts` creates or updates one MR per branch on GitHub and GitLab, re-probes before it writes, replaces only the text between the markers, lints the final body, sets assignee and reviewers by the rule, and writes nothing under `--dry-run`. Serves ARK-316/AC7.

Expected: When an MR exists, the system shall replace only the text between `<!-- pr-writing:begin -->` and `<!-- pr-writing:end -->`.

## Preconditions

- A fake `gh` and a fake `glab` on PATH that record each call and answer from a small state file. Token owner is `cobekarhoff`.
- A body file between the markers `<!-- pr-writing:begin -->` and `<!-- pr-writing:end -->` that passes lint, and a second body file that has a `fail` (a `ghp_` token).
- An existing MR whose body has text before and after the markers, including a template checkbox a human ticked (`- [x] Tested locally`).
- Config `reviewers` list: variant 1 `[alice, bob]`; variant 2 `[cobekarhoff]` (only the author); variant 3 `[cobekarhoff, alice]`.

## Steps

1. With no MR on the branch, post the body file on GitHub (`gh`). Count create calls.
2. Repeat step 1 on GitLab (`glab`).
3. With the MR now existing, post a changed body file. Diff the MR body before and after.
4. Make the fake host's MR probe fail (non-zero exit), then post. Read the calls.
5. Make the first probe say "no MR" and a second probe, just before the write, say "MR exists" (a race). Post.
6. Post the file with the `ghp_` token as create and as update.
7. Post with reviewers variants 1, 2 and 3. Read assignee and reviewers in the calls.
8. Post with `--dry-run` for create and for update. Read the output and the host state.
9. Run `bun test test/pr-writing.test.ts`.

## Expected results

- Create: one MR is created on `gh` and one on `glab`, with the body from the file.
- Update: only the text between the markers changes. The human tick `- [x] Tested locally` and all text outside the markers are unchanged.
- The host is probed for an MR on the source branch just before the write; the race in step 5 turns the create into an update, and only one MR exists.
- A failing probe makes no create or update call and reports the failure.
- The final body is linted after the rewrite. A `fail` (the `ghp_` token) refuses the post for create and for update, and nothing is written.
- Assignee is the token owner. Reviewers come from `reviewers` and never include the author: variant 1 sets `alice` and `bob`; variant 2 sets no reviewer and prints a warning; variant 3 sets `alice` only.
- `--dry-run` prints each host call it would make and writes nothing (the fake host state is unchanged).
- `bun test test/pr-writing.test.ts` exits 0.

## Screenshot checkpoints

None. The surface is CLI output and Markdown text; no screenshot applies.
